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

## Feishu-MCP (Lark) Integration

Bridge 自动挂载 [cso1z/Feishu-MCP](https://github.com/cso1z/Feishu-MCP) 作为 Claude 的 MCP server，让 Claude Code 能调飞书 API（读/写云文档、浏览云空间）。

### Current config

- Auth: `tenant`（用现有 `CTI_FEISHU_APP_ID` / `CTI_FEISHU_APP_SECRET`）
- Modules: `document,drive`
- Mode: stdio（每次 query 启动 `npx -y feishu-mcp@latest --stdio`）
- 详见 `src/claude-provider.ts` 的 `buildMcpServers()`

### ⚠️ 飞书 app 必须授权 scopes

**tenant auth 需要 app 后台显式授权**。缺失的 scope 会让 Claude 收到 MCP server 返回的权限错误。

#### 千万**不要**用「批量导入 JSON」覆盖现有 scopes

⚠️ **危险**：飞书「权限管理 → 批量导入」是**覆盖式**导入，会**清掉所有现有 scope**。

要加 scope，正确做法是：
1. **先去「批量导出」备份当前 JSON**（万一翻车能恢复）
2. **手动在权限管理 UI 里勾选**一个个加 —— 不要用批量导入
3. **加完后再批量导出验证** —— 确认只多了新加的

#### 当前生产 app 的 scope（2026-07-02 复制自飞书后台）

**tenant scopes** (63 个，10 个是 2026-07-02 为 Feishu-MCP 新增):

```
aily:data_asset:upload_file
aily:file:read
aily:file:write
application:application:self_manage
base:app:read               # NEW (Feishu-MCP)
bitable:app
bitable:app:readonly
board:whiteboard:node:create # NEW (Feishu-MCP)
board:whiteboard:node:read   # NEW (Feishu-MCP)
cardkit:card:read
cardkit:card:write
contact:contact.base:readonly
contact:user.base:readonly
contact:user.employee_id:readonly # NEW (Feishu-MCP)
corehr:file:download
docs:document.content:read  # NEW (Feishu-MCP)
docs:document.media:upload
docx:document
docx:document.block:convert
docx:document:create          # NEW (Feishu-MCP)
docx:document:readonly
drive:drive
drive:drive:readonly
drive:file
drive:file:download
drive:file:readonly
drive:file:upload
im:chat.members:read
im:chat:read
im:chat:readonly
im:chat:update
im:message
im:message.group_at_msg:readonly
im:message.group_msg
im:message.p2p_msg:readonly
im:message.pins:read
im:message.pins:write_only
im:message.reactions:read
im:message.reactions:write_only
im:message:readonly
im:message:recall
im:message:send_as_bot
im:message:send_multi_users
im:message:send_sys_msg
im:message:update
im:resource
minutes:minutes.media:export
sheets:spreadsheet
sheets:spreadsheet.meta:read
sheets:spreadsheet.meta:write_only
sheets:spreadsheet:create
sheets:spreadsheet:read
sheets:spreadsheet:readonly
sheets:spreadsheet:write_only
space:document:retrieve      # NEW (Feishu-MCP)
space:folder:create          # NEW (Feishu-MCP)
speech_to_text:speech
task:task:read
task:task:write
wiki:space:read              # NEW (Feishu-MCP)
wiki:space:retrieve          # NEW (Feishu-MCP)
wiki:wiki
wiki:wiki:readonly
```

**user scopes** (140+ 个):

```
approval:instance:read
approval:instance:write
approval:task:read
approval:task:write
base:app:copy
base:app:create
base:app:read
base:app:update
base:dashboard:create
base:dashboard:delete
base:dashboard:read
base:dashboard:update
base:field:create
base:field:delete
base:field:read
base:field:update
base:form:create
base:form:delete
base:form:read
base:form:update
base:history:read
base:record:create
base:record:delete
base:record:read
base:record:retrieve
base:record:update
base:role:create
base:role:delete
base:role:read
base:role:update
base:table:create
base:table:delete
base:table:read
base:table:update
base:view:read
base:view:write_only
base:workflow:create
base:workflow:delete
base:workflow:read
base:workflow:update
base:workspace:list
bitable:app
bitable:app:readonly
board:whiteboard:node:create
board:whiteboard:node:delete
board:whiteboard:node:read
calendar:calendar.event:create
calendar:calendar.event:delete
calendar:calendar.event:read
calendar:calendar.event:reply
calendar:calendar.event:update
calendar:calendar.free_busy:read
calendar:calendar:create
calendar:calendar:delete
calendar:calendar:read
calendar:calendar:update
contact:contact.base:readonly
contact:user.base:readonly
contact:user.basic_profile:readonly
contact:user.employee_id:readonly
contact:user:search
docs:document.comment:create
docs:document.comment:delete
docs:document.comment:read
docs:document.comment:update
docs:document.comment:write_only
docs:document.content:read
docs:document.media:download
docs:document.media:upload
docs:document:copy
docs:document:export
docs:document:import
docs:event:subscribe
docs:permission.member:auth
docs:permission.member:create
docs:permission.member:transfer
docx:document:create
docx:document:readonly
docx:document:write_only
drive:drive.metadata:readonly
drive:file:download
drive:file:upload
drive:file:view_record:readonly
im:chat.members:read
im:chat.members:write_only
im:chat:read
im:chat:update
im:message
im:message.group_msg:get_as_user
im:message.p2p_msg:get_as_user
im:message.pins:read
im:message.pins:write_only
im:message.reactions:read
im:message.reactions:write_only
im:message:readonly
mail:event
mail:user_mailbox.mail_contact:read
mail:user_mailbox.mail_contact:write
mail:user_mailbox.message.address:read
mail:user_mailbox.message.body:read
mail:user_mailbox.message.subject:read
mail:user_mailbox.message:modify
mail:user_mailbox.message:readonly
mail:user_mailbox:readonly
minutes:minutes.media:export
minutes:minutes.search:read
offline_access
search:docs:read
search:message
sheets:spreadsheet
sheets:spreadsheet.meta:read
sheets:spreadsheet.meta:write_only
sheets:spreadsheet:create
sheets:spreadsheet:read
sheets:spreadsheet:readonly
sheets:spreadsheet:write_only
slides:presentation:create
slides:presentation:read
slides:presentation:update
slides:presentation:write_only
space:document:delete
space:document:move
space:document:retrieve
space:document:shortcut
space:folder:create
task:comment:read
task:comment:write
task:task:read
task:task:write
task:task:writeonly
task:tasklist:read
task:tasklist:write
vc:meeting.meetingevent:read
vc:meeting.search:read
vc:note:read
vc:record:readonly
wiki:member:create
wiki:member:retrieve
wiki:member:update
wiki:node:copy
wiki:node:create
wiki:node:move
wiki:node:read
wiki:node:retrieve
wiki:node:update
wiki:space:read
wiki:space:retrieve
wiki:space:write_only
wiki:wiki:readonly
```

#### 如果 MCP 报权限不足

虽然上面的 tenant scopes 看起来已经覆盖了 `drive:drive:readonly` / `docx:document:readonly` 等，但还是可能报权限不足 —— 常见原因：

1. **scope 已添加但 app 没发布新版本**（必须「版本管理与发布 → 创建版本 → 审核通过」才生效）
2. **MCP 用的 APP_ID 跟这个有权限的 app 不是同一个**（检查 `CTI_FEISHU_APP_ID`）
3. **user auth 才能用某些 scope**（如 task / calendar）—— 当前我们用 `FEISHU_AUTH_TYPE=tenant`，task / calendar / mail 等 user-only 权限无效

需要新增 scope，**不要用 JSON 批量导入**，直接在飞书后台权限管理 UI 里勾选。

### 调试

如果集成出问题，先看：
```bash
journalctl --user -u feishu-bridge.service -n 50
```

**已知风险**：
- `npx -y feishu-mcp@latest` 每次启动下载最新版（不固定版本号）→ 可能引入 breaking change
- APP_ID/SECRET 会经 SDK 序列化进 `--mcp-config` JSON，出现在子进程 cmdline（只 son_goku 自己可见，跟 minimax/glm secret 同处理）
- 首次启动 npx 下载包会慢 10-20 秒

## Private Memory (Claude Memory Bridge)

**目标**：让飞书侧能管理 Claude Code CLI 自己的记忆 ——「私人助手」定位的核心能力。

### 设计原则

- **不重复造轮子**：Claude Code CLI 已经会自动加载 `~/.claude/CLAUDE.md` 到 system prompt；bridge 直接桥接到这个机制，不另存一份 KV。
- **不冲突**：bridge 只在 `~/.claude/CLAUDE.md` 里维护一个独立区间（marker 标记），CLI 写的部分 byte-for-byte 保留。
- **飞书侧管理**：你在飞书发 `/remember` 改的就是 Claude 自己的 CLAUDE.md，跨 chat / 跨 session 生效。

### 实现

源码：`src/claude-memory.ts`（`ClaudeMemory` 类） + `src/bridge.ts`（4 个命令）。

bridge 写入的格式：

```markdown
... (CLI / 你之前 AI 写的内容) ...

<!-- BRIDGE_MEMORY_START -->

## language
用中文回复

## style
简短直接

<!-- BRIDGE_MEMORY_END -->
```

- `<!-- BRIDGE_MEMORY_START/END -->` 标记是 bridge 的写入边界
- CLI / 你手编的 `~/.claude/CLAUDE.md` **其他部分完全保留**
- 多次 `/remember` 自动 upsert（不重复添加同名 key）
- `/forget` 把区间内对应 section 删除；区间变空时整个 marker 块移除

### 命令

| 命令 | 作用 | 示例 |
|------|------|------|
| `/remember <key> <value>` | 存记忆 | `/remember style 简短直接` |
| `/recall [key]` | 不带 key 显示完整 `~/.claude/CLAUDE.md`；带 key 显示单条 value | `/recall style` |
| `/forget <key>` | 删除一条 | `/forget style` |
| `/memories` | 列出 bridge 管理的所有 entries | — |

### 验证

已验证（2026-07-02）：`/remember style 简短直接` 后，Claude 在新对话里**真的**按偏好回复（"认识。简短直接、说做就做……"）—— 说明 system prompt 自动加载 `~/.claude/CLAUDE.md` 生效。

### 已知边界 / Phase 2 待做

- ❌ **多行 value 不支持**（`/remember` 不接受换行）—— Phase 2
- ❌ **无 file lock** —— Phase 1 单用户 + 低并发风险可接受；Phase 2 加 fcntl 锁防止与 CLI /memory 编辑冲突
- ❌ **不自动 redaction** —— 用户自己负责不要存 secrets（建议：不在 key/value 里写密码 / token / API key）
- ❌ **不自动建议记忆** —— Claude 不会主动说"要不要记住这个"，需要用户手动 `/remember`

### 与 CLI /memory 的关系

| 写入方 | 文件位置 | bridge 是否动 |
|--------|----------|----------------|
| 用户手编（手动编辑） | 文件任意位置 | ❌ 不动 |
| CLI `/memory` 命令 | 整文件 | ❌ 不动（区间外） |
| **bridge `/remember`** | 末尾 BRIDGE 区间 | ✅ 写入 |
| 飞书侧 `/recall` (无 key) | 读全文件 | ❌ 只读 |

两边**不会冲突**，因为：
- bridge 写入有明确 marker
- 区间外 byte-for-byte 保留
- 写入是 atomic（先写 tmp 再 rename）

### 调试

```bash
# 看 bridge 区间当前内容
grep -A 5 "BRIDGE_MEMORY" ~/.claude/CLAUDE.md

# 看 Claude 怎么读 CLAUDE.md（CLI 自动，应该生效）
claude --version
# 然后新起一个 claude 问"你认识我吗"
```

## Project Identity (私人助手定位)

**这是个**个人 AI 助手 fork，不是通用工具**。

跟 [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) 1.6k⭐ 的差异：
- 那个项目：多 IM / 多 agent / 多用户场景 → 通用工具
- 这个 fork：**专注 Claude Code + 飞书 + 单用户私人助手** → 差异化

### 私人助手特性优先级

✅ **做**（私人化 + 实用）：
- `/remember /recall /forget` —— 让 Claude 认识你
- 飞书侧管理 Claude CLI 记忆

❌ **不做**（不是私人助手核心 / 超出范围）：
- 多 IM 平台（Slack/Discord/Telegram 等）—— 你只要飞书
- 多 agent 后端（Codex 等）—— 你只用 Claude
- Profiles / 多 bot —— 本地用
- 云文档评论触发 —— 通用
- 定时任务 cron —— 按需触发更好
- Web UI —— 私人不必要
- OS-user 隔离 —— 单机用
- 语音消息 —— 不常用

## For Architecture & Implementation Details

See [ARCHITECTURE.md](./ARCHITECTURE.md) — read that file before making code changes.
