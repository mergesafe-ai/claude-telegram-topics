# claude-telegram-topics

One Telegram forum topic per Claude Code session. Start agents on your laptop,
then follow and direct each one from its own topic on your phone.

```
Telegram group (Topics on)
   │  one bot, one poller
   ▼
router  (127.0.0.1:8799, started on demand)
   │  topic ⇄ session
   ▼
each Claude session → channel.ts (MCP channel)
```

- A session starts → its topic (`<repo> · <branch>`) is created or reopened, with "🟢 Agent started".
- You write in the topic → only that session receives it.
- Claude replies → in its topic. Permission prompts arrive as ✅ / ❌ buttons.
- The session ends → "⚪ Agent ended". The next session with the same name reuses the topic.
- `/agents` in any topic lists what's running.

Why a router: Telegram allows one `getUpdates` poller per bot token, so the
official plugin can't serve several sessions at once.

## Setup

1. Create a bot with @BotFather and save the token: `/telegram:configure <token>` in Claude Code
   (stored in `~/.claude/channels/telegram/.env`), or put `"token"` in `config.json`.
2. Create a group, turn **Topics** on, add the bot, make it an **admin**, and post one message.
3. `bun install && bun src/setup.ts` — writes the group id and your user id to
   `~/.claude/channels/telegram-topics/config.json`. Every human who posted in the group is
   allowlisted, so run it while you're the only poster.
4. Register the channel and disable the official Telegram plugin (both would poll the same bot):
   ```sh
   claude mcp add -s user telegram-topics -- ~/.bun/bin/bun "$PWD/src/channel.ts"
   claude plugin disable telegram@claude-plugins-official
   ```
5. Start Claude with the channel:
   ```sh
   claude --dangerously-load-development-channels server:telegram-topics
   ```

`TELEGRAM_AGENT_NAME=...` overrides the topic name. Claude can also rename its topic with the
`rename_topic` tool.

## Files

| Path | What |
|---|---|
| `src/router.ts` | Owns the bot; maps topics ⇄ sessions; relays permission buttons |
| `src/channel.ts` | Per-session MCP channel; starts the router if it isn't running |
| `src/setup.ts` | Finds the group and your user id from recent updates |
| `~/.claude/channels/telegram-topics/` | `config.json`, `topics.json`, `router.log` |
