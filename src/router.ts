#!/usr/bin/env bun
/**
 * The router owns the bot. Telegram allows exactly one getUpdates poller per
 * token, so every Claude session talks to this process over a localhost
 * WebSocket instead of polling Telegram itself.
 *
 * One live session ⇄ one forum topic. Topics are remembered by agent name
 * (repo · branch), so restarting the same agent lands in the same topic.
 */
import { Bot, InlineKeyboard, InputFile } from 'grammy'
import type { ServerWebSocket } from 'bun'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { extname, join } from 'path'
import {
  loadConfig,
  PID_FILE,
  STATE_DIR,
  TOPICS_FILE,
  type RouterToSession,
  type SessionToRouter,
} from './shared'

const cfg = loadConfig()
if (!cfg.token) die('no bot token — run /telegram:configure <token> or set token in config.json')
if (!cfg.groupId) die('no groupId — run `bun src/setup.ts` after posting a message in the group')
const GROUP = cfg.groupId
const ALLOW = new Set(cfg.allowFrom.map(String))
if (ALLOW.size === 0) die('allowFrom is empty — run `bun src/setup.ts`')

const INBOX = join(STATE_DIR, 'inbox')
mkdirSync(INBOX, { recursive: true })
writeFileSync(PID_FILE, String(process.pid))

type Session = { ws: ServerWebSocket<Data>; name: string; threadId: number }
type Data = { session?: Session }

/** agent name → topic thread id, persisted so topics survive restarts. */
const topics: Record<string, number> = existsSync(TOPICS_FILE)
  ? JSON.parse(readFileSync(TOPICS_FILE, 'utf8'))
  : {}
const saveTopics = () => writeFileSync(TOPICS_FILE, JSON.stringify(topics, null, 2) + '\n')

const byThread = new Map<number, Session>()
/** permission request id → owning session, so a button press reaches the right agent. */
const permOwner = new Map<string, Session>()
const permDetails = new Map<string, { tool_name: string; description: string; input_preview: string }>()

const bot = new Bot(cfg.token)
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

function send(s: Session, msg: RouterToSession) {
  s.ws.send(JSON.stringify(msg))
}

function log(...a: unknown[]) {
  process.stderr.write(`[${new Date().toISOString()}] ${a.join(' ')}\n`)
}

function die(msg: string): never {
  process.stderr.write(`telegram-topics router: ${msg}\n`)
  process.exit(1)
}

// ── Topic lifecycle ──

async function topicFor(baseName: string): Promise<{ name: string; threadId: number }> {
  // Two live sessions with the same name get "#2", "#3" — each still its own topic.
  let name = baseName
  for (let n = 2; [...byThread.values()].some(s => s.name === name); n++) name = `${baseName} #${n}`

  const known = topics[name]
  if (known) {
    try {
      await bot.api.reopenForumTopic(GROUP, known)
    } catch (e) {
      // "TOPIC_NOT_MODIFIED" means it was already open; anything else means it's gone.
      if (!String(e).includes('TOPIC_NOT_MODIFIED')) {
        log(`topic ${known} for ${name} unusable (${e}); creating a new one`)
        delete topics[name]
      }
    }
    if (topics[name]) return { name, threadId: known }
  }
  const t = await bot.api.createForumTopic(GROUP, name.slice(0, 128))
  topics[name] = t.message_thread_id
  saveTopics()
  return { name, threadId: t.message_thread_id }
}

function chunks(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) out.push(rest)
  return out
}

async function handleSessionMessage(ws: ServerWebSocket<Data>, msg: SessionToRouter) {
  if (msg.type === 'hello') {
    const { name, threadId } = await topicFor(msg.name)
    const s: Session = { ws, name, threadId }
    ws.data.session = s
    byThread.set(threadId, s)
    send(s, { type: 'welcome', threadId, name })
    await bot.api
      .sendMessage(GROUP, `🟢 Agent started\n📁 ${msg.cwd}`, { message_thread_id: threadId })
      .catch(e => log('start notice failed', e))
    log(`session up: ${name} → thread ${threadId}`)
    return
  }

  const s = ws.data.session
  if (!s) return

  if (msg.type === 'reply') {
    try {
      const ids: number[] = []
      const parts = chunks(msg.text)
      for (let i = 0; i < parts.length; i++) {
        const m = await bot.api.sendMessage(GROUP, parts[i]!, {
          message_thread_id: s.threadId,
          ...(i === 0 && msg.reply_to ? { reply_parameters: { message_id: msg.reply_to } } : {}),
        })
        ids.push(m.message_id)
      }
      for (const f of msg.files ?? []) {
        const input = new InputFile(f)
        const m = PHOTO_EXTS.has(extname(f).toLowerCase())
          ? await bot.api.sendPhoto(GROUP, input, { message_thread_id: s.threadId })
          : await bot.api.sendDocument(GROUP, input, { message_thread_id: s.threadId })
        ids.push(m.message_id)
      }
      send(s, { type: 'result', id: msg.id, ok: true, message_ids: ids })
    } catch (e) {
      send(s, { type: 'result', id: msg.id, ok: false, error: String(e) })
    }
    return
  }

  if (msg.type === 'rename') {
    try {
      await bot.api.editForumTopic(GROUP, s.threadId, { name: msg.name.slice(0, 128) })
      delete topics[s.name]
      s.name = msg.name
      topics[s.name] = s.threadId
      saveTopics()
      send(s, { type: 'result', id: msg.id, ok: true })
    } catch (e) {
      send(s, { type: 'result', id: msg.id, ok: false, error: String(e) })
    }
    return
  }

  if (msg.type === 'permission') {
    const { request_id, tool_name, description, input_preview } = msg
    permOwner.set(request_id, s)
    permDetails.set(request_id, { tool_name, description, input_preview })
    const kb = new InlineKeyboard()
      .text('See more', `perm:more:${request_id}`)
      .text('✅ Allow', `perm:allow:${request_id}`)
      .text('❌ Deny', `perm:deny:${request_id}`)
    await bot.api
      .sendMessage(GROUP, `🔐 Permission: ${tool_name}\n${description}`, {
        message_thread_id: s.threadId,
        reply_markup: kb,
      })
      .catch(e => log('permission send failed', e))
  }
}

async function sessionClosed(s: Session) {
  if (byThread.get(s.threadId) === s) byThread.delete(s.threadId)
  for (const [id, owner] of permOwner) if (owner === s) permOwner.delete(id)
  await bot.api
    .sendMessage(GROUP, '⚪ Agent ended', { message_thread_id: s.threadId })
    .catch(() => {})
  log(`session down: ${s.name}`)
}

// ── Telegram side ──

function allowed(chatId: number, fromId?: number) {
  return chatId === GROUP && fromId != null && ALLOW.has(String(fromId))
}

bot.command('agents', async ctx => {
  if (!allowed(ctx.chat.id, ctx.from?.id)) return
  const live = [...byThread.values()]
  await ctx.reply(
    live.length ? live.map(s => `🟢 ${s.name}`).join('\n') : 'No agents running.',
    { message_thread_id: ctx.message?.message_thread_id },
  )
})

bot.on('callback_query:data', async ctx => {
  const m = /^perm:(allow|deny|more):([a-km-z]{5})$/.exec(ctx.callbackQuery.data)
  if (!m || !ALLOW.has(String(ctx.from.id))) {
    await ctx.answerCallbackQuery(m ? { text: 'Not authorized.' } : {}).catch(() => {})
    return
  }
  const [, behavior, id] = m as unknown as [string, 'allow' | 'deny' | 'more', string]
  if (behavior === 'more') {
    const d = permDetails.get(id)
    let input = d?.input_preview ?? ''
    try {
      input = JSON.stringify(JSON.parse(input), null, 2)
    } catch {}
    await ctx
      .editMessageText(
        d ? `🔐 Permission: ${d.tool_name}\n${d.description}\n\n${input}`.slice(0, 4000) : 'Details expired.',
        { reply_markup: new InlineKeyboard().text('✅ Allow', `perm:allow:${id}`).text('❌ Deny', `perm:deny:${id}`) },
      )
      .catch(() => {})
    await ctx.answerCallbackQuery().catch(() => {})
    return
  }
  const owner = permOwner.get(id)
  if (!owner) {
    await ctx.answerCallbackQuery({ text: 'That agent is gone.' }).catch(() => {})
    return
  }
  send(owner, { type: 'permission_answer', request_id: id, behavior })
  permOwner.delete(id)
  permDetails.delete(id)
  const label = behavior === 'allow' ? '✅ Allowed' : '❌ Denied'
  await ctx.answerCallbackQuery({ text: label }).catch(() => {})
  const text = ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : ''
  await ctx.editMessageText(`${text}\n\n${label}`).catch(() => {})
})

bot.on(['message:text', 'message:photo'], async ctx => {
  if (!allowed(ctx.chat.id, ctx.from?.id)) return
  const thread = ctx.message.message_thread_id
  const s = thread != null ? byThread.get(thread) : undefined
  if (!s) {
    // General topic, or a topic whose agent isn't running.
    if (thread != null && Object.values(topics).includes(thread)) {
      await ctx.reply('⚪ This agent isn\'t running. Start it from your laptop.', { message_thread_id: thread })
    }
    return
  }

  let image_path: string | undefined
  if (ctx.message.photo) {
    try {
      const best = ctx.message.photo[ctx.message.photo.length - 1]!
      const file = await ctx.api.getFile(best.file_id)
      const res = await fetch(`https://api.telegram.org/file/bot${cfg.token}/${file.file_path}`)
      image_path = join(INBOX, `${Date.now()}-${best.file_unique_id}${extname(file.file_path ?? '.jpg')}`)
      writeFileSync(image_path, Buffer.from(await res.arrayBuffer()))
    } catch (e) {
      log('photo download failed', e)
    }
  }

  void ctx.api.sendChatAction(GROUP, 'typing', { message_thread_id: thread }).catch(() => {})
  send(s, {
    type: 'inbound',
    text: ctx.message.text ?? ctx.message.caption ?? '(photo)',
    message_id: ctx.message.message_id,
    user: ctx.from.username ?? String(ctx.from.id),
    user_id: String(ctx.from.id),
    ts: new Date(ctx.message.date * 1000).toISOString(),
    ...(image_path ? { image_path } : {}),
  })
})

// A throw in a handler must not stop polling.
bot.catch(err => log('handler error:', err.error))

// ── Local WebSocket server ──

Bun.serve<Data>({
  hostname: '127.0.0.1',
  port: cfg.port,
  fetch(req, server) {
    const url = new URL(req.url)
    if (url.searchParams.get('secret') !== cfg.secret) return new Response('forbidden', { status: 403 })
    if (server.upgrade(req, { data: {} })) return
    return new Response('telegram-topics router')
  },
  websocket: {
    message(ws, raw) {
      let msg: SessionToRouter
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      handleSessionMessage(ws, msg).catch(e => log('session message failed', e))
    },
    close(ws) {
      if (ws.data.session) void sessionClosed(ws.data.session)
    },
  },
})

log(`router listening on 127.0.0.1:${cfg.port}, group ${GROUP}`)
bot.start({ allowed_updates: ['message', 'callback_query'], drop_pending_updates: true })
