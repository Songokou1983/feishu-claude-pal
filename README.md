# feishu-claude-pal

[![CI](https://github.com/Songokou1983/feishu-claude-pal/actions/workflows/test.yml/badge.svg)](https://github.com/Songokou1983/feishu-claude-pal/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/Songokou1983/feishu-claude-pal)](https://github.com/Songokou1983/feishu-claude-pal/releases)
[![License: MIT](https://img.shields.io/github/license/Songokou1983/feishu-claude-pal)](./LICENSE)

> Your personal AI assistant, living inside Feishu (Lark) and powered by Claude Code CLI.

A fork of [PI-33/feishu-claude-bridge](https://github.com/PI-33/feishu-claude-bridge) focused on **personal-assistant use cases** — fewer platforms, more memory, more "knows you".

## Why this fork exists

Most Claude + IM bridges (e.g. [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge), [cc-connect](https://github.com/chenhg5/cc-connect)) are built as **general-purpose tools** — multi-platform, multi-agent, multi-user.

This fork is the opposite: **one user, one platform, deep integration with Claude Code CLI**. The bet is that a personal assistant should *know* its user, not just *serve* them.

### What's different

| Feature | This fork | Typical bridges |
|---|---|---|
| Feishu (Lark) only | ✅ | Multi-IM |
| Claude Code CLI only | ✅ | Multi-agent |
| **Private memory** (bridges to `~/.claude/CLAUDE.md`) | ✅ | ❌ |
| **Feishu-MCP** (lets Claude call Feishu API: docs, drive) | ✅ | ❌ |
| Multi-model (Claude + minimax + GLM-5.1) | ✅ | Claude only |
| systemd service (Linux), launchd (macOS) | ✅ | ✅ |

## Quick start (5 minutes)

### 1. Install

```bash
git clone https://github.com/Songokou1983/feishu-claude-pal.git
cd feishu-claude-pal
npm install
npm run build
```

### 2. Create a Feishu app

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) and create a new enterprise self-built app
2. Enable **Bot** capability
3. Subscribe to event `im.message.receive_v1` (WebSocket — no public IP needed)
4. Add the scopes listed in `CLAUDE.md` § "Feishu-MCP"
5. Publish a version and have an admin approve it

### 3. Configure

```bash
cp config.env.example config.env
# Edit config.env with your CTI_FEISHU_APP_ID, CTI_FEISHU_APP_SECRET, and CTI_DEFAULT_WORKDIR
```

### 4. Install systemd service (Linux)

```bash
# Edit .config/systemd/user/feishu-bridge.service to match your install path
systemctl --user daemon-reload
systemctl --user enable feishu-bridge.service
systemctl --user start feishu-bridge.service
journalctl --user -u feishu-bridge.service -f
```

### 4b. Docker (alternative)

```bash
# Build image
docker compose build

# Edit config.env with your Feishu app credentials
cp config.env.example config.env
$EDITOR config.env

# Start daemon
docker compose up -d

# Logs
docker compose logs -f

# Health
curl http://localhost:18888/health

# Stop
docker compose down
```

The `docker-compose.yml` mounts:
- `config.env` (read-only) for credentials
- `bridge-data` named volume for `.bridge/` runtime data (sessions, bindings)
- exposes port 18888 to localhost only for the health endpoint

Note: `/remember` writes to `~/.claude/CLAUDE.md` — Docker users will need to mount `~/.claude/` (commented in `docker-compose.yml`) to persist memories on the host.

### 5. Talk to your bot

Send any message to the bot in Feishu. You'll get a streaming card with the response.

## Commands

| Command | What it does |
|---|---|
| `/help` | Show all commands |
| `/status` | Current session status (model, CWD, SDK session ID) |
| `/list` | Discover local CLI sessions |
| `/resume <id>` | Resume a CLI session |
| `/new [path]` | Start a new session |
| `/cwd /path` | Change working directory |
| `/mode plan\|code\|ask` | Switch Claude permission mode |
| `/tree [depth] [path]` | Show project file tree |
| `/diff [--staged]` | Show git diff |
| `/models` | List available model providers |
| `/cost` | Show token usage for current session |
| `/remember <key> <value>` | Persist a memory (bridges to `~/.claude/CLAUDE.md`) |
| `/recall [key]` | View memories or single key |
| `/forget <key>` | Delete a memory |
| `/memories` | List bridge-managed memories |
| `/stop` | Stop the current task |
| `/perm allow\|deny <id>` | Permission response |

## Private memory

The killer feature: `/remember` writes directly into your `~/.claude/CLAUDE.md` (which Claude Code CLI already auto-loads). No duplicate KV store, no conflict with CLI's own `/memory` — bridge-managed content is clearly marked:

```markdown
... (your existing content / CLI /memory output) ...

<!-- BRIDGE_MEMORY_START -->

## style
简短直接

## language
中文回复

<!-- BRIDGE_MEMORY_END -->
```

After `/remember style 简短直接`, the very next Claude query in Feishu (or terminal!) will respond in that style.

## Feishu-MCP

Lets Claude read/write Feishu documents and browse Drive from inside a Feishu chat. Powered by [cso1z/Feishu-MCP](https://github.com/cso1z/Feishu-MCP).

Example:

> "用 feishu 工具列出我能访问的所有飞书云文档"
> "读飞书 wiki https://feishu.cn/wiki/abc123 并总结"

See `CLAUDE.md` for required scopes and troubleshooting.

## Configuration

All config lives in `config.env`. Most important fields:

| Variable | Purpose |
|---|---|
| `CTI_FEISHU_APP_ID` / `CTI_FEISHU_APP_SECRET` | Feishu app credentials |
| `CTI_DEFAULT_WORKDIR` | Default CWD for new sessions |
| `CTI_FEISHU_ALLOWED_USERS` | Comma-separated allowlist of open_ids (security) |
| `CTI_AUTO_APPROVE` | `true` to auto-allow all tool calls (less safe) |
| `MINIMAX_BASE_URL` / `MINIMAX_AUTH_TOKEN` | Enable `minimax` model provider |
| `GLM_BASE_URL` / `GLM_API_KEY` | Enable `glm-5.1` model provider |

See `config.env.example` for the full list.

## Architecture

```
Feishu IM (mobile/desktop)
        ↕  WebSocket (no public IP)
  ┌─────────────────────────────────┐
  │  daemon (Node.js + systemd)     │
  │  ┌──────────┐  ┌─────────────┐  │
  │  │ feishu.ts│  │  bridge.ts  │  │
  │  │  WS +    │  │ /commands + │  │
  │  │  CardKit │  │ message     │  │
  │  │  v2      │  │ routing     │  │
  │  └────┬─────┘  └──────┬──────┘  │
  │       │               │         │
  │  ┌────┴───────────────┴──────┐  │
  │  │  claude-provider.ts       │  │
  │  │  + Feishu-MCP server     │  │
  │  └────────────┬──────────────┘  │
  └───────────────┼─────────────────┘
                  ↕  (SDK query() with mcpServers)
         ┌────────────────────┐
         │  Claude Code CLI    │
         │  (with mcp config)  │
         └────────────────────┘
```

Persistent state: `~/.bridge/data/` (sessions, bindings, messages, audit log, dedup).

## Known limitations

- **Claude Code CLI 2.1.159** is pinned (newer versions may block third-party LLM providers). See [CLAUDE.md](./CLAUDE.md) for details.
- Feishu Card 2.0's `collapsible_panel` does NOT collapse in chat messages — long responses render inline.
- No file lock on `~/.claude/CLAUDE.md` (single user, low concurrency; Phase 2).

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # 99 unit tests
npm run build        # esbuild bundle → dist/daemon.mjs
```

## License

MIT — see [LICENSE](./LICENSE). Forked from [PI-33/feishu-claude-bridge](https://github.com/PI-33/feishu-claude-bridge) (MIT).

## Credits

- [PI-33/feishu-claude-bridge](https://github.com/PI-33/feishu-claude-bridge) — the original bridge
- [cso1z/Feishu-MCP](https://github.com/cso1z/Feishu-MCP) — Feishu MCP server
- [@larksuiteoapi/node-sdk](https://www.npmjs.com/package/@larksuiteoapi/node-sdk) — Feishu SDK
- [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — Claude Code SDK
