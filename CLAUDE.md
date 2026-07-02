# CLAUDE.md — Setup Guide for AI Assistants

When a user clones this project and asks you to help set it up, follow these steps.

## What This Is

Feishu Claude Bridge — a Node.js daemon that connects Feishu/Lark to Claude Code CLI. Users chat with a bot in Feishu, the daemon calls Claude Code, and streams responses back as real-time cards.

## Prerequisites

- **Node.js >= 20** (`node --version`)
- **Claude Code CLI** installed and logged in (`claude --version`)
- **Feishu enterprise self-built app** (see Feishu App Setup below)

## Install & Build

```bash
cd /path/to/feishu-claude-bridge
npm install
npm run build
```

`npm run build` uses esbuild to bundle `src/` → `dist/daemon.mjs`.

## Configure

```bash
cp config.env.example config.env
```

Edit `config.env`:

```bash
# ── Required ──
CTI_FEISHU_APP_ID=cli_xxxxxxxxxx
CTI_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
CTI_DEFAULT_WORKDIR=/path/to/your/project

# ── Optional ──
CTI_FEISHU_DOMAIN=feishu            # "feishu" or "lark"
CTI_DEFAULT_MODE=code               # code / plan / ask
CTI_FEISHU_REQUIRE_MENTION=true     # Require @bot in group chats
# CTI_FEISHU_ALLOWED_USERS=ou_xxx   # Access control (comma-separated)
# CTI_AUTO_APPROVE=true             # Auto-approve all tool permissions
# CTI_CLAUDE_CODE_EXECUTABLE=/path/to/claude  # Override CLI path

# ── Third-party API provider (optional) ──
# MiniMax (Claude Sonnet 4 compatible)
# ANTHROPIC_API_KEY=your-key
# ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
# ANTHROPIC_AUTH_TOKEN=your-key
# MINIMAX_BASE_URL=https://api.minimaxi.com/anthropic
# MINIMAX_AUTH_TOKEN=your-key

# ── 模型选项 ──
# 可用模型：minimax / glm-5.1
# 通过 /model 命令切换
# CTI_DEFAULT_MODEL=glm-5.1

# ── 火山引擎 Ark (GLM) ──
# GLM_BASE_URL=https://ark.cn-beijing.volces.com/api/coding  # 注意：不是 /api/coding/v1
# GLM_API_KEY=your-ark-api-key
```

## Feishu App Setup

In the [Feishu Open Platform](https://open.feishu.cn/app):

1. Create enterprise self-built app
2. Enable **Bot** capability
3. Go to **Events & Callbacks** → select **Use persistent connection** (WebSocket)
4. Subscribe to event: `im.message.receive_v1`
5. Add scopes:
   - `im:message` — Send messages
   - `im:message.receive_v1` — Receive messages
   - `im:message:readonly` — Read messages
   - `im:resource` — Upload/download resources
   - `im:chat:readonly` — Read chat list
   - `im:message.reactions:write_only` — Typing indicator
   - `cardkit:card` — CardKit v2 streaming cards
6. Publish app version

## Start

```bash
# Daemon mode (macOS launchd, auto-restarts on crash)
bash scripts/daemon.sh start

# Check status
bash scripts/daemon.sh status

# View logs
bash scripts/daemon.sh logs

# Stop
bash scripts/daemon.sh stop
```

Or foreground for debugging: `npm run dev` or `npm start` (requires build first)

> `daemon.sh` is macOS-only (uses launchd). On other platforms, use `npm run dev` or a process manager like pm2 / systemd.

## Verify It Works

```bash
bash scripts/daemon.sh logs
```

Look for these lines in order:
1. `[ws] client ready` — REST client initialized
2. `[feishu] Started (botOpenId: ou_xxx)` — Bot identity resolved
3. `[ws] ws client ready` — WebSocket connected

Then send any message to the bot in Feishu. It should reply.

## Development

```bash
npm run typecheck              # TypeScript check (tsc --noEmit)
npm run dev                    # Foreground mode
npm run build                  # Production build

npx tsx --test src/__tests__/unit.test.ts         # 55 unit tests (no network)
npx tsx --test src/__tests__/feishu-api.test.ts    # 5 API connectivity tests
npx tsx --test src/__tests__/integration.test.ts   # 6 full integration tests
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Cannot start: missing appId or appSecret` | Check `config.env` exists in the project root and has credentials |
| WebSocket doesn't connect | Enable "使用长连接接收事件" in Feishu dev console |
| Bot doesn't respond in group | @mention the bot, or set `CTI_FEISHU_REQUIRE_MENTION=false` |
| Permission denied / 403 | Add missing scopes in Feishu dev console and republish |
| `claude` CLI not found | Install Claude Code CLI, or set `CTI_CLAUDE_CODE_EXECUTABLE` |
| Card rendering fails | Add `cardkit:card` scope and republish |

## ⚠️ Known Feishu Chat Limitations

Confirmed 2026-07-02 after B2-2 experiment. **Read before adding any card UI feature**.

### 1. `collapsible_panel` does NOT collapse in chat messages

The Card 2.0 `collapsible_panel` element with `expanded: false` is **ignored by the chat rendering layer** — content is always shown expanded regardless of the field. User testing with a 9996-char Go tutorial showed the panel header (`▸ Show full response (X chars)`) but the full content was displayed inline.

**Why**: The SDK type def (`@larksuiteoapi/node-sdk`) does not include `collapsible_panel`. WebFetch hint suggested it exists, but empirical testing shows the chat message renderer ignores the `expanded` flag. (The component may work in dashboard / standalone card contexts, but not in chat stream.)

**Implication**: **Do not implement "long content folding" via `collapsible_panel` in chat messages.** Alternatives if you really need folding:
- Truncate markdown content to 1500 chars + add "回复 /full 看完整" command (requires storing full content in store)
- Split into multiple chat messages (each ≤ 30KB)
- Accept that long messages render inline (current behavior)

### 2. Markdown content has no automatic truncation

Long markdown content in a single card element renders fully inline. Plan UX accordingly.

### 3. `cardkit.v1.card.update` sequence counter

Card updates require strictly monotonic `sequence` numbers. The current implementation increments on every flush — keep this invariant when modifying `feishu.ts` `flushCardUpdate` / `finalizeCard`.

## For Architecture & Implementation Details

See [ARCHITECTURE.md](./ARCHITECTURE.md) — read that file before making code changes.
