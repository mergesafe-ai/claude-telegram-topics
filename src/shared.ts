import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'

export const STATE_DIR =
  process.env.TELEGRAM_TOPICS_STATE_DIR ??
  join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels', 'telegram-topics')

export const CONFIG_FILE = join(STATE_DIR, 'config.json')
export const TOPICS_FILE = join(STATE_DIR, 'topics.json')
export const LOG_FILE = join(STATE_DIR, 'router.log')
export const PID_FILE = join(STATE_DIR, 'router.pid')

// The official plugin's token file — reused so there is one place to rotate the token.
const OFFICIAL_ENV = join(
  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
  'channels',
  'telegram',
  '.env',
)

export type Config = {
  /** Bot token. Falls back to TELEGRAM_BOT_TOKEN in ~/.claude/channels/telegram/.env. */
  token?: string
  /** The forum supergroup (negative id, -100…) that holds one topic per agent. */
  groupId?: number
  /** Telegram user ids allowed to drive agents and answer permission prompts. */
  allowFrom: number[]
  /** Router listen port on 127.0.0.1. */
  port: number
  /** Shared secret sessions present to the router. Generated on first run. */
  secret: string
}

export function loadConfig(): Config {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  let cfg: Partial<Config> = {}
  if (existsSync(CONFIG_FILE)) cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  const full: Config = {
    allowFrom: [],
    port: 8799,
    secret: '',
    ...cfg,
  }
  if (!full.secret) {
    full.secret = randomBytes(24).toString('hex')
    saveConfig(full)
  }
  if (!full.token) full.token = readOfficialToken()
  return full
}

export function saveConfig(cfg: Config) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  // Never persist a token we only borrowed from the official plugin's .env.
  const { token, ...rest } = cfg
  const out = token && token !== readOfficialToken() ? cfg : rest
  writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 })
  chmodSync(CONFIG_FILE, 0o600)
}

function readOfficialToken(): string | undefined {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN
  try {
    const m = readFileSync(OFFICIAL_ENV, 'utf8').match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)
    return m?.[1]?.trim()
  } catch {
    return undefined
  }
}

// ── Router ⇄ session wire protocol (JSON over a localhost WebSocket) ──

export type SessionToRouter =
  | { type: 'hello'; name: string; cwd: string }
  | { type: 'reply'; id: string; text: string; files?: string[]; reply_to?: number }
  | { type: 'rename'; id: string; name: string }
  | {
      type: 'permission'
      request_id: string
      tool_name: string
      description: string
      input_preview: string
    }

export type RouterToSession =
  | { type: 'welcome'; threadId: number; name: string }
  | { type: 'result'; id: string; ok: boolean; error?: string; message_ids?: number[] }
  | {
      type: 'inbound'
      text: string
      message_id: number
      user: string
      user_id: string
      ts: string
      image_path?: string
    }
  | { type: 'permission_answer'; request_id: string; behavior: 'allow' | 'deny' }
