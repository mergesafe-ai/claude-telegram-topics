#!/usr/bin/env bun
/**
 * One-time setup: finds your forum group and your Telegram user id from the
 * bot's recent updates and writes them to config.json.
 *
 * Before running: add the bot to a group with Topics on, make it an admin,
 * and post any message in the group. Stop the router first — Telegram only
 * lets one process read updates.
 */
import { Bot } from 'grammy'
import { CONFIG_FILE, loadConfig, saveConfig } from './shared'

const cfg = loadConfig()
if (!cfg.token) {
  console.error('No bot token. Run /telegram:configure <token> in Claude Code first.')
  process.exit(1)
}
const bot = new Bot(cfg.token)
const me = await bot.api.getMe()
const updates = await bot.api.getUpdates({ limit: 100, timeout: 0 })

const groups = new Map<number, string>()
const users = new Map<number, string>()
for (const u of updates) {
  const m = u.message ?? u.my_chat_member
  if (!m) continue
  if (m.chat.type === 'supergroup' && 'is_forum' in m.chat && m.chat.is_forum) groups.set(m.chat.id, m.chat.title)
  if (u.message?.from && !u.message.from.is_bot && m.chat.type === 'supergroup') {
    users.set(u.message.from.id, u.message.from.username ?? u.message.from.first_name)
  }
}

if (groups.size === 0) {
  console.error(
    `No forum group seen by @${me.username}. Turn Topics on, add the bot as admin, post a message in the group, and rerun.`,
  )
  process.exit(1)
}
if (groups.size > 1 && !process.argv[2]) {
  console.error('Several forum groups found — rerun with the id you want:')
  for (const [id, title] of groups) console.error(`  bun src/setup.ts ${id}   # ${title}`)
  process.exit(1)
}

const groupId = process.argv[2] ? Number(process.argv[2]) : [...groups.keys()][0]!
if (!Number.isSafeInteger(groupId) || !groups.has(groupId)) {
  console.error(`Group ${process.argv[2]} is not one of the forum groups found above.`)
  process.exit(1)
}
cfg.groupId = groupId
cfg.allowFrom = [...new Set([...cfg.allowFrom, ...users.keys()])]
saveConfig(cfg)

console.log(`Group: ${groups.get(groupId)} (${groupId})`)
console.log(`Allowed users: ${[...users].map(([id, n]) => `${n} (${id})`).join(', ') || '(none seen — post in the group and rerun)'}`)
console.log(`Saved ${CONFIG_FILE}`)
