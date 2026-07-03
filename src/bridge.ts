/**
 * Bridge — message orchestrator for the Feishu-Claude bridge.
 *
 * Consumes inbound messages from FeishuClient, routes slash commands,
 * handles numeric permission shortcuts, and dispatches to the conversation engine.
 * Uses per-session locks for concurrency control.
 */

import type {
  AppContext,
  InboundMessage,
  ChannelBinding,
  CliSessionInfo,
  ToolCallInfo,
} from './types.js';
import * as conversation from './conversation.js';
import { deliver } from './delivery.js';
import {
  forwardPermissionRequest,
  handlePermissionCallback,
} from './permissions.js';
import {
  validateWorkingDirectory,
  validateSessionId,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './validators.js';
import { formatRelativeTime } from './session-scanner.js';
import { htmlToFeishuMarkdown, formatTokenCount } from './feishu-markdown.js';
import { ClaudeMemory } from './claude-memory.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ── /list cache (per-chat, 5 min TTL) ───────────────────────

interface ListCacheEntry {
  sessions: CliSessionInfo[];
  cachedAt: number;
}

const LIST_CACHE_TTL = 5 * 60 * 1000;
const listCache = new Map<string, ListCacheEntry>();

function getCachedList(chatId: string): CliSessionInfo[] | null {
  const entry = listCache.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > LIST_CACHE_TTL) {
    listCache.delete(chatId);
    return null;
  }
  return entry.sessions;
}

// ── Session locks ────────────────────────────────────────────

const sessionLocks = new Map<string, Promise<void>>();

function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const prev = sessionLocks.get(sessionId) || Promise.resolve();
  const current = prev.then(fn, fn);
  sessionLocks.set(sessionId, current);
  current.finally(() => {
    if (sessionLocks.get(sessionId) === current) {
      sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

// ── Active tasks ─────────────────────────────────────────────

const activeTasks = new Map<string, AbortController>();

// ── Numeric permission shortcut check ────────────────────────

function isNumericPermissionShortcut(ctx: AppContext, rawText: string, chatId: string): boolean {
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const pending = ctx.store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0;
}

// ── Resolve binding ──────────────────────────────────────────

function resolveBinding(ctx: AppContext, chatId: string): ChannelBinding {
  const existing = ctx.store.getChannelBinding(chatId);
  if (existing) {
    const session = ctx.store.getSession(existing.codepilotSessionId);
    if (session) return existing;
  }
  return createNewBinding(ctx, chatId);
}

function createNewBinding(ctx: AppContext, chatId: string, workDir?: string): ChannelBinding {
  const cwd = workDir || ctx.config.defaultWorkDir || process.env.HOME || '';
  const model = ctx.config.defaultModel || '';
  const session = ctx.store.createSession(`Bridge: ${chatId}`, model, undefined, cwd);
  return ctx.store.upsertChannelBinding({
    chatId,
    codepilotSessionId: session.id,
    workingDirectory: cwd,
    model,
  });
}

// ── SDK Session Update Logic ─────────────────────────────────

function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId && !hasError) return sdkSessionId;
  if (hasError) return '';
  return null;
}

// ── CLI Session Helpers ──────────────────────────────────────

function findCliSession(ctx: AppContext, query: string): CliSessionInfo | null {
  const sessions = ctx.store.listCliSessions({ limit: 50 });
  const q = query.toLowerCase();
  const byId = sessions.find(s => s.sdkSessionId.toLowerCase().startsWith(q));
  if (byId) return byId;
  const bySlug = sessions.find(s => s.slug.toLowerCase() === q);
  return bySlug || null;
}

function resumeCliSession(ctx: AppContext, chatId: string, target: CliSessionInfo): string {
  const model = ctx.config.defaultModel || '';
  const session = ctx.store.createSession(
    `Resume: ${target.slug || target.sdkSessionId.slice(0, 8)}`,
    model,
    undefined,
    target.cwd,
  );

  const binding = ctx.store.upsertChannelBinding({
    chatId,
    codepilotSessionId: session.id,
    workingDirectory: target.cwd,
    model,
  });

  ctx.store.updateChannelBinding(binding.id, { sdkSessionId: target.sdkSessionId });

  const icon = target.isOpen ? '🟢' : '⚪';
  const prompt = target.firstPrompt.length > 40 ? target.firstPrompt.slice(0, 40) + '...' : target.firstPrompt;
  return [
    `${icon} 已恢复 CLI 会话`,
    '',
    `Project: \`${target.project}\``,
    `CWD: \`${target.cwd}\``,
    target.slug ? `Slug: \`${target.slug}\`` : '',
    `"${prompt}"`,
    '',
    `终端恢复: \`claude --resume ${target.sdkSessionId}\``,
    '',
    '现在可以直接发消息继续对话。',
  ].filter(Boolean).join('\n');
}

// ── Main loop ────────────────────────────────────────────────

export async function runBridgeLoop(ctx: AppContext): Promise<void> {
  while (ctx.feishu.isRunning()) {
    try {
      const msg = await ctx.feishu.consumeOne();
      if (!msg) continue;

      if (
        msg.callbackData ||
        msg.text.trim().startsWith('/') ||
        isNumericPermissionShortcut(ctx, msg.text.trim(), msg.chatId)
      ) {
        await handleMessage(ctx, msg);
      } else {
        const binding = resolveBinding(ctx, msg.chatId);
        processWithSessionLock(binding.codepilotSessionId, () =>
          handleMessage(ctx, msg),
        ).catch(err => {
          console.error(`[bridge] Session ${binding.codepilotSessionId.slice(0, 8)} error:`, err);
        });
      }
    } catch (err) {
      console.error('[bridge] Error in loop:', err);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ── Message handler ──────────────────────────────────────────

async function handleMessage(ctx: AppContext, msg: InboundMessage): Promise<void> {
  // Handle callback queries (permission buttons)
  if (msg.callbackData) {
    const handled = handlePermissionCallback(ctx, msg.callbackData, msg.chatId, msg.callbackMessageId);
    if (handled) {
      await deliver(ctx, msg.chatId, 'Permission response recorded.');
    }
    return;
  }

  const rawText = msg.text.trim();
  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  if (!rawText && !hasAttachments) return;

  // Numeric shortcut for permission replies (1/2/3)
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (/^[123]$/.test(normalized)) {
    const pendingLinks = ctx.store.listPendingPermissionLinksByChat(msg.chatId);
    if (pendingLinks.length === 1) {
      const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
      const action = actionMap[normalized];
      const permId = pendingLinks[0].permissionRequestId;
      const callbackData = `perm:${action}:${permId}`;
      const handled = handlePermissionCallback(ctx, callbackData, msg.chatId);
      const label = normalized === '1' ? 'Allow' : normalized === '2' ? 'Allow Session' : 'Deny';
      if (handled) {
        await deliver(ctx, msg.chatId, `${label}: recorded.`);
      } else {
        await deliver(ctx, msg.chatId, 'Permission not found or already resolved.');
      }
      return;
    }
    if (pendingLinks.length > 1) {
      await deliver(ctx, msg.chatId,
        `Multiple pending permissions (${pendingLinks.length}). Use /perm allow|allow_session|deny <id>`,
      );
      return;
    }
    // No pending → fall through as normal message
  }

  // Slash commands
  if (rawText.startsWith('/')) {
    await handleCommand(ctx, msg, rawText);
    return;
  }

  // Sanitize
  const { text, truncated } = sanitizeInput(rawText);
  if (truncated) {
    console.warn(`[bridge] Input truncated from ${rawText.length} to ${text.length} chars`);
  }

  if (!text && !hasAttachments) return;

  // Regular message → conversation engine
  const binding = resolveBinding(ctx, msg.chatId);

  ctx.feishu.onMessageStart(msg.chatId);

  const taskAbort = new AbortController();
  activeTasks.set(binding.codepilotSessionId, taskAbort);

  // Tool call tracker for streaming card
  const toolCallTracker = new Map<string, ToolCallInfo>();

  const onPartialText = (fullText: string) => {
    try { ctx.feishu.onStreamText(msg.chatId, fullText); } catch { /* non-critical */ }
  };

  const onToolEvent = (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => {
    if (toolName) {
      toolCallTracker.set(toolId, { id: toolId, name: toolName, status });
    } else {
      const existing = toolCallTracker.get(toolId);
      if (existing) existing.status = status;
    }
    try {
      ctx.feishu.onToolEvent(msg.chatId, Array.from(toolCallTracker.values()));
    } catch { /* non-critical */ }
  };

  try {
    const promptText = text || (hasAttachments ? 'Describe this image.' : '');

    const result = await conversation.processMessage(
      ctx,
      binding,
      promptText,
      async (perm) => {
        await forwardPermissionRequest(
          ctx,
          msg.chatId,
          perm.permissionRequestId,
          perm.toolName,
          perm.toolInput,
          binding.codepilotSessionId,
          perm.suggestions,
          msg.messageId,
        );
      },
      taskAbort.signal,
      hasAttachments ? msg.attachments : undefined,
      onPartialText,
      onToolEvent,
    );

    // Finalize streaming card
    let cardFinalized = false;
    try {
      const status = result.hasError ? 'error' : 'completed';
      cardFinalized = await ctx.feishu.onStreamEnd(msg.chatId, status, result.responseText, result.tokenUsage);
    } catch (err) {
      console.warn('[bridge] Card finalize failed:', err instanceof Error ? err.message : err);
    }

    // Send response text (skip if card was finalized)
    if (result.responseText) {
      if (!cardFinalized) {
        await deliver(ctx, msg.chatId, result.responseText, {
          sessionId: binding.codepilotSessionId,
          parseMode: 'Markdown',
          replyToMessageId: msg.messageId,
        });
      }
    } else if (result.hasError) {
      const errorText = `**Error:** ${result.errorMessage}`;
      await deliver(ctx, msg.chatId, errorText, {
        sessionId: binding.codepilotSessionId,
        parseMode: 'Markdown',
        replyToMessageId: msg.messageId,
      });
    }

    // Persist SDK session ID
    if (binding.id) {
      try {
        const update = computeSdkSessionUpdate(result.sdkSessionId, result.hasError);
        if (update !== null) {
          ctx.store.updateChannelBinding(binding.id, { sdkSessionId: update });
        }
      } catch { /* best effort */ }
    }
  } finally {
    if (taskAbort.signal.aborted) {
      try {
        await ctx.feishu.onStreamEnd(msg.chatId, 'interrupted', '');
      } catch { /* best effort */ }
    }
    activeTasks.delete(binding.codepilotSessionId);
    ctx.feishu.onMessageEnd(msg.chatId);
  }
}

// ── Slash commands ───────────────────────────────────────────

export async function handleCommand(
  ctx: AppContext,
  msg: InboundMessage,
  text: string,
): Promise<void> {
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0].toLowerCase();
  const args = parts.slice(1).join(' ').trim();

  // Dangerous input check
  const dangerCheck = isDangerousInput(text);
  if (dangerCheck.dangerous) {
    console.warn(`[bridge] Blocked dangerous input: ${dangerCheck.reason}`);
    await deliver(ctx, msg.chatId, 'Command rejected: invalid input detected.');
    return;
  }

  let response = '';

  switch (command) {
    case '/start':
    case '/help':
      response = [
        '**Feishu-Claude Bridge**',
        '',
        'Send any message to interact with Claude.',
        '',
        '**Commands:**',
        '/new [path] - Start new session',
        '/bind <session_id> - Bind to existing session',
        '/list - Discover local CLI sessions',
        '/resume <编号或ID> - Resume a CLI session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/model minimax|glm - Switch API provider model',
        '/models - Show available models & config status',
        '/tree [depth] [path] - Show project file tree (default 2, max 4)',
        '/diff [--staged] - Show git diff',
        '/cost - Show token usage & cost for current session',
        '/remember <key> <value> - Persist a memory (bridges to ~/.claude/CLAUDE.md)',
        '/recall [key] - View memories (or single key)',
        '/forget <key> - Delete a memory',
        '/memories - List all bridge-managed memories',
        '/status - Show current status',
        '/stop - Stop current session',
        '/perm allow|allow_session|deny <id> - Permission response',
        '1/2/3 - Quick permission reply (single pending)',
        '/help - Show this help',
      ].join('\n');
      break;

    case '/new': {
      const oldBinding = resolveBinding(ctx, msg.chatId);
      const oldTask = activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        activeTasks.delete(oldBinding.codepilotSessionId);
      }

      let workDir: string | undefined;
      if (args) {
        const validated = validateWorkingDirectory(args);
        if (!validated) {
          response = 'Invalid path. Must be an absolute path without traversal sequences.';
          break;
        }
        workDir = validated;
      }
      const binding = createNewBinding(ctx, msg.chatId, workDir);
      response = [
        'New session created.',
        `Session: \`${binding.codepilotSessionId.slice(0, 8)}...\``,
        `CWD: \`${binding.workingDirectory || '~'}\``,
      ].join('\n');
      break;
    }

    case '/bind': {
      if (!args) {
        response = 'Usage: /bind <session_id>';
        break;
      }
      if (!validateSessionId(args)) {
        response = 'Invalid session ID format.';
        break;
      }
      const session = ctx.store.getSession(args);
      if (session) {
        ctx.store.upsertChannelBinding({
          chatId: msg.chatId,
          codepilotSessionId: args,
          workingDirectory: session.working_directory,
          model: session.model,
        });
        response = `Bound to session \`${args.slice(0, 8)}...\``;
      } else {
        const cliSession = findCliSession(ctx, args);
        if (cliSession) {
          response = resumeCliSession(ctx, msg.chatId, cliSession);
        } else {
          response = 'Session not found.';
        }
      }
      break;
    }

    case '/cwd': {
      if (!args) {
        response = 'Usage: /cwd /path/to/directory';
        break;
      }
      const validatedPath = validateWorkingDirectory(args);
      if (!validatedPath) {
        response = 'Invalid path.';
        break;
      }
      const binding = resolveBinding(ctx, msg.chatId);
      ctx.store.updateChannelBinding(binding.id, { workingDirectory: validatedPath });
      response = `Working directory set to \`${validatedPath}\``;
      break;
    }

    case '/mode': {
      if (!validateMode(args)) {
        response = 'Usage: /mode plan|code|ask';
        break;
      }
      const binding = resolveBinding(ctx, msg.chatId);
      ctx.store.updateChannelBinding(binding.id, { mode: args as 'code' | 'plan' | 'ask' });
      response = `Mode set to **${args}**`;
      break;
    }

    case '/model': {
      const modelMap: Record<string, string> = {
        minimax: 'minimax',
        glm: 'glm-5.1',
        'glm-5.1': 'glm-5.1',
      };
      const arg = args.toLowerCase().trim();
      const resolved = modelMap[arg];
      if (!resolved) {
        response = [
          '可用模型:',
          '  `/model minimax` — MiniMax (Claude Sonnet 4)',
          '  `/model glm`     — GLM-5.1 (火山引擎 Ark)',
        ].join('\n');
        break;
      }
      const binding = resolveBinding(ctx, msg.chatId);
      ctx.store.updateChannelBinding(binding.id, { model: resolved });
      response = resolved === 'minimax'
        ? 'Model set to **MiniMax** (Claude Sonnet 4)'
        : 'Model set to **GLM-5.1** (火山引擎 Ark)';
      break;
    }

    case '/status': {
      const binding = resolveBinding(ctx, msg.chatId);
      const lines = [
        '**Bridge Status**',
        '',
        `CWD: \`${binding.workingDirectory || '~'}\``,
        `Mode: **${binding.mode}**`,
        `Model: \`${binding.model || 'default'}\``,
      ];
      if (binding.sdkSessionId) {
        lines.push('', `SDK Session (用于终端 \`claude --resume\`):`);
        lines.push(`\`${binding.sdkSessionId}\``);
      } else {
        lines.push('', 'SDK Session: 尚未建立（发一条消息后生成）');
      }
      response = lines.join('\n');
      break;
    }

    case '/stop': {
      const binding = resolveBinding(ctx, msg.chatId);
      const taskAbort = activeTasks.get(binding.codepilotSessionId);
      if (taskAbort) {
        taskAbort.abort();
        activeTasks.delete(binding.codepilotSessionId);
        response = 'Stopping current task...';
      } else {
        response = 'No task is currently running.';
      }
      break;
    }

    case '/perm': {
      const permParts = args.split(/\s+/);
      const permAction = permParts[0];
      const permId = permParts.slice(1).join(' ');
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        response = 'Usage: /perm allow|allow_session|deny <permission_id>';
        break;
      }
      const callbackData = `perm:${permAction}:${permId}`;
      const handled = handlePermissionCallback(ctx, callbackData, msg.chatId);
      response = handled
        ? `Permission ${permAction}: recorded.`
        : 'Permission not found or already resolved.';
      break;
    }

    case '/list': {
      const sessions = ctx.store.listCliSessions({ limit: 20 });
      if (sessions.length === 0) {
        response = 'No local CLI sessions found.';
        break;
      }
      listCache.set(msg.chatId, { sessions, cachedAt: Date.now() });

      const lines = ['**本地 CLI 会话:**', ''];
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const icon = s.isOpen ? '🟢' : '⚪';
        const prompt = s.firstPrompt.length > 40 ? s.firstPrompt.slice(0, 40) + '...' : s.firstPrompt;
        const timeAgo = formatRelativeTime(s.timestamp);
        lines.push(`${i + 1}. ${icon} \`${s.sdkSessionId.slice(0, 8)}\`  ${s.project}`);
        lines.push(`   "${prompt}" (${timeAgo})`);
      }
      lines.push('');
      lines.push('发送 /resume <编号> 恢复会话');
      response = lines.join('\n');
      break;
    }

    case '/resume': {
      if (!args) {
        response = 'Usage: /resume <编号或ID>\n先发送 /list 查看可用会话。';
        break;
      }

      let target: CliSessionInfo | null = null;

      const num = parseInt(args, 10);
      if (!isNaN(num) && num > 0 && String(num) === args.trim()) {
        const cached = getCachedList(msg.chatId);
        if (cached && num <= cached.length) {
          target = cached[num - 1];
        } else {
          const freshSessions = ctx.store.listCliSessions({ limit: 20 });
          listCache.set(msg.chatId, { sessions: freshSessions, cachedAt: Date.now() });
          if (num <= freshSessions.length) {
            target = freshSessions[num - 1];
          }
        }
        if (!target) {
          response = `编号 ${num} 超出范围。发送 /list 查看可用会话。`;
          break;
        }
      }

      if (!target) {
        target = findCliSession(ctx, args);
      }

      if (!target) {
        response = `未找到匹配 "${args}" 的会话。\n发送 /list 查看可用会话。`;
        break;
      }

      // Abort running task
      const oldBinding = resolveBinding(ctx, msg.chatId);
      const oldTask = activeTasks.get(oldBinding.codepilotSessionId);
      if (oldTask) {
        oldTask.abort();
        activeTasks.delete(oldBinding.codepilotSessionId);
      }

      response = resumeCliSession(ctx, msg.chatId, target);
      break;
    }

    case '/tree':
      response = await cmdTree(ctx, msg.chatId, args);
      break;

    case '/diff':
      response = await cmdDiff(ctx, msg.chatId, args);
      break;

    case '/models':
      response = cmdModels(ctx, msg.chatId, args);
      break;

    case '/cost':
      response = cmdCost(ctx, msg.chatId, args);
      break;

    case '/remember':
      response = cmdRemember(args);
      break;

    case '/recall':
      response = cmdRecall(args);
      break;

    case '/forget':
      response = cmdForget(args);
      break;

    case '/memories':
      response = cmdMemories();
      break;

    default:
      response = `Unknown command: ${command}\nType /help for available commands.`;
  }

  if (response) {
    await deliver(ctx, msg.chatId, response, {
      parseMode: 'Markdown',
      replyToMessageId: msg.messageId,
    });
  }
}

// ── Slash command implementations ────────────────────────────

const TREE_IGNORE = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', '.next', '.nuxt', '.cache', '.parcel-cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'target', 'vendor', '.venv', 'venv', 'env',
  '.DS_Store', 'Thumbs.db',
  'coverage', '.nyc_output', '.turbo', '.vercel',
  '.idea', '.vscode', '*.log', '*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
]);
const TREE_MAX_ENTRIES_PER_DIR = 30;
const TREE_DEFAULT_DEPTH = 2;
const TREE_MAX_DEPTH = 4;
const DIFF_MAX_LENGTH = 4000;

export function buildTree(
  rootPath: string,
  displayPath: string,
  maxDepth: number,
  currentDepth = 0,
): string {
  if (currentDepth >= maxDepth) return '';

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch (err) {
    return `  ⚠️  无法读取: ${err instanceof Error ? err.message : String(err)}\n`;
  }

  // Sort: dirs first, then files, alphabetical
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const visible = entries.filter((e) => !TREE_IGNORE.has(e.name));
  const truncated = visible.length > TREE_MAX_ENTRIES_PER_DIR;
  const shown = truncated ? visible.slice(0, TREE_MAX_ENTRIES_PER_DIR) : visible;

  const prefix = '│   '.repeat(currentDepth);
  const lines: string[] = [];

  for (const entry of shown) {
    const suffix = entry.isDirectory() ? '/' : '';
    lines.push(`${prefix}├── ${entry.name}${suffix}`);
    if (entry.isDirectory()) {
      const childPath = path.join(rootPath, entry.name);
      const subtree = buildTree(childPath, path.join(displayPath, entry.name), maxDepth, currentDepth + 1);
      if (subtree) lines.push(subtree);
    }
  }

  if (truncated) {
    lines.push(`${prefix}└── ... (${visible.length - TREE_MAX_ENTRIES_PER_DIR} more, 用 /tree <depth> 调浅)`);
  }

  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

async function cmdTree(ctx: AppContext, chatId: string, args: string): Promise<string> {
  const binding = resolveBinding(ctx, chatId);
  const cwd = binding.workingDirectory || ctx.config.defaultWorkDir || process.cwd();

  // Parse args: <depth> [path]
  let depth = TREE_DEFAULT_DEPTH;
  let target = cwd;

  const tokens = args.split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      depth = Math.max(1, Math.min(parseInt(t, 10), TREE_MAX_DEPTH));
    } else {
      const validated = validateWorkingDirectory(t);
      if (!validated) {
        return `Invalid path: \`${t}\`\nUsage: \`/tree [depth] [path]\`\n  depth: 1-${TREE_MAX_DEPTH} (default ${TREE_DEFAULT_DEPTH})\n  path:  absolute path (default: current CWD)`;
      }
      target = validated;
    }
  }

  if (!fs.existsSync(target)) {
    return `Path does not exist: \`${target}\``;
  }

  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    return `Not a directory: \`${target}\``;
  }

  try {
    const tree = buildTree(target, target, depth);
    const totalEntries = tree.split('\n').filter(Boolean).length;
    const header = `**Tree of \`${target}\`** (depth ${depth}, ${totalEntries} entries)`;
    return tree ? `${header}\n\`\`\`\n${tree}\`\`\`` : `${header}\n\`(empty)\``;
  } catch (err) {
    return `Tree failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function cmdDiff(ctx: AppContext, chatId: string, args: string): Promise<string> {
  const binding = resolveBinding(ctx, chatId);
  const cwd = binding.workingDirectory || process.cwd();

  if (!fs.existsSync(cwd)) {
    return `Working directory does not exist: \`${cwd}\``;
  }

  try {
    // Check if git repo
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return `Not a git repository: \`${cwd}\``;
  }

  // Get diff scope: empty = working tree, --staged = staged only
  const staged = args.trim() === '--staged';
  const diffArgs = staged ? ['diff', '--staged'] : ['diff'];

  let stat: string;
  let diff: string;
  try {
    stat = execFileSync('git', [...diffArgs, '--stat'], {
      cwd, encoding: 'utf-8', timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    diff = execFileSync('git', diffArgs, {
      cwd, encoding: 'utf-8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return `Git diff failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (!diff.trim()) {
    return staged
      ? 'No staged changes.'
      : 'No uncommitted changes.';
  }

  const lines: string[] = [];
  lines.push(`**Git Diff** (\`${cwd}\`)${staged ? ' — staged' : ''}`);
  if (stat) lines.push('', '```', stat, '```');
  if (diff.length > DIFF_MAX_LENGTH) {
    lines.push('', '```', diff.slice(0, DIFF_MAX_LENGTH), '```');
    lines.push(`\n... truncated (${diff.length - DIFF_MAX_LENGTH} more chars). Use \`/diff --staged\` or run \`git diff\` locally.`);
  } else {
    lines.push('', '```', diff, '```');
  }
  return lines.join('\n');
}

function cmdModels(ctx: AppContext, _chatId: string, _args: string): string {
  const config = ctx.config;
  const binding = ctx.store.getChannelBinding(_chatId);

  const providers: Array<{ key: string; label: string; configured: boolean; hint: string }> = [
    {
      key: 'minimax',
      label: 'MiniMax (Claude Sonnet 4)',
      configured: !!(config.minimaxBaseUrl && config.minimaxAuthToken),
      hint: 'MINIMAX_BASE_URL + MINIMAX_AUTH_TOKEN',
    },
    {
      key: 'glm-5.1',
      label: 'GLM-5.1 (火山引擎 Ark)',
      configured: !!(config.glmBaseUrl && config.glmApiKey),
      hint: 'GLM_BASE_URL + GLM_API_KEY',
    },
  ];

  const lines: string[] = ['**可用模型**', ''];
  lines.push(`Default config: \`${config.defaultModel || '(跟随 CLI 默认)'}\``);
  lines.push(`当前会话: \`${binding?.model || config.defaultModel || '(default)'}\``);
  lines.push('');
  lines.push('**第三方供应商:**');
  for (const p of providers) {
    const mark = p.configured ? '✅' : '⚠️ ';
    const note = p.configured ? '' : ` (未配置, 需在 config.env 设 ${p.hint})`;
    lines.push(`  ${mark} \`${p.key}\` — ${p.label}${note}`);
  }
  lines.push('');
  lines.push('切换: `/model <key>`');
  lines.push('查看完整 SDK session: `/status`');
  return lines.join('\n');
}

function cmdCost(ctx: AppContext, chatId: string, _args: string): string {
  const binding = resolveBinding(ctx, chatId);
  const summary = ctx.store.getUsageSummary(binding.codepilotSessionId);
  if (!summary) {
    return [
      '**Token 用量**',
      '',
      '本会话还没有任何 token 用量数据（还没有 assistant 消息或 usage 还没记录）。',
      '',
      '**说明**:',
      '• `/cost` 只统计当前 binding 关联的 session（`/status` 显示 SDK session）',
      '• 用量数据从 SDK result 事件的 `usage` 字段聚合',
      '• 如果你换了 `/new` / `/bind`，会切到新 session，统计从零开始',
    ].join('\n');
  }

  const lines: string[] = ['**Token 用量** (本会话)', ''];
  lines.push(`📊 消息数: ${summary.messageCount}`);
  lines.push(`📥 Input: ${formatTokenCount(summary.totalInput)} tokens`);
  lines.push(`📤 Output: ${formatTokenCount(summary.totalOutput)} tokens`);
  if (summary.totalCacheRead > 0 || summary.totalCacheCreation > 0) {
    const totalCache = summary.totalCacheRead + summary.totalCacheCreation;
    lines.push(`⚡ Cache: ${formatTokenCount(totalCache)} tokens (read ${formatTokenCount(summary.totalCacheRead)} + write ${formatTokenCount(summary.totalCacheCreation)})`);
  }
  lines.push(`💵 Cost: $${summary.totalCostUsd.toFixed(4)}`);
  lines.push('');
  const total = summary.totalInput + summary.totalOutput;
  if (total > 0) {
    const inPct = (summary.totalInput / total * 100).toFixed(1);
    const outPct = (summary.totalOutput / total * 100).toFixed(1);
    lines.push(`📈 Input / Output 占比: ${inPct}% / ${outPct}%`);
  }
  return lines.join('\n');
}

// ── Memory commands (bridge-managed section in ~/.claude/CLAUDE.md) ──

const memory = new ClaudeMemory();

function cmdRemember(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) {
    return 'Usage: `/remember <key> <value>`\nExample: `/remember language 用中文回复`';
  }
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    return 'Usage: `/remember <key> <value>`\n需要 key 和 value（用空格分隔）';
  }
  const key = trimmed.slice(0, spaceIdx).trim();
  const value = trimmed.slice(spaceIdx + 1).trim();
  if (!key || !value) {
    return 'Usage: `/remember <key> <value>`\nkey 和 value 都不能为空';
  }
  if (key.includes('\n') || value.includes('\n')) {
    return '❌ key 和 value 不能包含换行（多行 value 暂不支持）';
  }
  memory.setEntry(key, value);
  return `✓ 已记住: \`${key}\` = ${value}\n\n(写入 \`~/.claude/CLAUDE.md\`，Claude 下次会自动加载)`;
}

function cmdRecall(args: string): string {
  const key = args.trim();
  if (key) {
    const entries = memory.readEntries();
    const entry = entries.find(e => e.key === key);
    if (entry) {
      return `**${entry.key}**\n${entry.value}`;
    }
    return `❌ 没找到: \`${key}\`\n\n用 \`/memories\` 看所有。`;
  }
  // No key → show all of CLAUDE.md (including CLI-managed content)
  const all = memory.readAll();
  if (!all) {
    return '**(~/.claude/CLAUDE.md 是空的)**\n\n用 `/remember <key> <value>` 添加记忆';
  }
  // Truncate if huge
  const maxLen = 4000;
  const display = all.length > maxLen ? all.slice(0, maxLen) + `\n\n... (截断，共 ${all.length} 字符)` : all;
  return `**~/.claude/CLAUDE.md 完整内容:**\n\n\`\`\`\n${display}\n\`\`\``;
}

function cmdForget(args: string): string {
  const key = args.trim();
  if (!key) {
    return 'Usage: `/forget <key>`';
  }
  const removed = memory.removeEntry(key);
  return removed
    ? `✓ 已忘记: \`${key}\``
    : `❌ 没找到: \`${key}\`\n\n用 \`/memories\` 看所有。`;
}

function cmdMemories(): string {
  const entries = memory.readEntries();
  if (entries.length === 0) {
    return [
      '**(暂无 bridge 管理的记忆)**',
      '',
      '用 `/remember <key> <value>` 添加，例如:',
      '`/remember language 用中文回复`',
      '`/remember style 简短直接`',
      '',
      '记忆会写入 `~/.claude/CLAUDE.md`，Claude 下次会自动加载。',
    ].join('\n');
  }
  const lines = ['**Bridge 记忆** (写入 ~/.claude/CLAUDE.md):', ''];
  for (const e of entries) {
    const preview = e.value.length > 80 ? e.value.slice(0, 77) + '...' : e.value;
    lines.push(`- \`${e.key}\`: ${preview}`);
  }
  lines.push('');
  lines.push('**说明**: 这些只是 bridge 写的部分。CLI 的 /memory 命令可以写更多。');
  return lines.join('\n');
}
