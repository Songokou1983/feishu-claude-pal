# Changelog

All notable changes to feishu-claude-pal will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-02

First release as `feishu-claude-pal`. Forked from [PI-33/feishu-claude-bridge](https://github.com/PI-33/feishu-claude-bridge) (MIT, May 2026).

### Added

- **Private memory system** — `/remember <key> <value>` writes directly into `~/.claude/CLAUDE.md` via a clearly-marked `<!-- BRIDGE_MEMORY_START/END -->` section. No duplicate KV store, no conflict with Claude Code CLI's own `/memory`. Verified working: Claude honors the memory in subsequent queries.
- **Feishu-MCP integration** — Claude can call Feishu APIs (read/write docs, browse Drive) via [cso1z/Feishu-MCP](https://github.com/cso1z/Feishu-MCP). Tenant auth, modules: `document,drive`.
- **Multi-model support** — `/model minimax` and `/model glm-5.1` switch between Claude, MiniMax, and 火山引擎 Ark (GLM-5.1). Backed by env-injected `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`.
- **Comprehensive error classification** — `claude-provider.ts` `classifyError()` recognizes rate_limit / network / model_not_found / context_too_long / permission_denied, each with actionable user message.
- **Real-time elapsed display** — Streaming cards now show `⏱ 12.3s` updating every ~200ms during streaming (not just at finalize).
- **4 slash commands** — `/tree [depth] [path]`, `/diff [--staged]`, `/models`, `/cost` (with token usage aggregation).
- **Token usage persistence** — `addMessage` now actually stores `usage: TokenUsage` (was previously a dangling parameter). `getUsageSummary()` aggregates across the session.
- **systemd service** (`feishu-bridge.service`) — auto-restart on crash, `journalctl --user -u feishu-bridge.service` for logs.
- **Secret redaction** in all log output via `logger.ts maskSecrets()`.

### Changed

- `addMessage` signature cleaned: `_usage` (ignored) → `usage` (persisted as JSON).
- 90 unit tests across config / validators / feishu-markdown / store / session-scanner / delivery / claude-provider / claude-memory / permissions / bridge-buildTree.
- Documentation in `CLAUDE.md` is the single source of truth for: project identity, system requirements, troubleshooting, Feishu-MCP scopes, private memory design, known limitations.

### Fixed

- **B2-2 reverted** (commits `3d9a05c` + `ea8c851`) — Feishu Card 2.0's `collapsible_panel` does NOT collapse in chat messages; the `expanded: false` flag is silently ignored by the chat renderer. Documented in `CLAUDE.md` § Known Feishu Chat Limitations.
- `sdk.larksuiteoapi/node-sdk` upgraded to 0.2.121 (from 0.2.92).
- TypeScript strict typecheck passes across all 16 source files.
- `Claude Code CLI` pinned to 2.1.159 — newer versions may block third-party LLM providers. See `CLAUDE.md` for rationale.

### Removed

- None (purely additive on top of upstream).

[Unreleased]: https://github.com/Songokou1983/feishu-claude-pal/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Songokou1983/feishu-claude-pal/releases/tag/v0.1.0
