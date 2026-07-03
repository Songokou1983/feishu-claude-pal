/**
 * Bridge slash command implementations.
 *
 * Each command takes (ctx, chatId, args?) and returns a markdown response
 * string. The switch dispatcher in bridge.ts routes slash commands to these.
 *
 * Separated from bridge.ts to keep the main file focused on the message
 * orchestration loop.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import type { AppContext, CliSessionInfo } from './types.js';
import { formatTokenCount } from './feishu-markdown.js';
import { formatRelativeTime } from './session-scanner.js';
import { validateWorkingDirectory } from './validators.js';
import { ClaudeMemory } from './claude-memory.js';
import {
  getCachedList,
  setCachedList,
  resolveBinding,
  createNewBinding,
  findCliSession,
  resumeCliSession,
} from './bridge-helpers.js';

// ── Tree / Diff constants + helpers ──

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

// ── 8 command implementations ──

export async function cmdTree(ctx: AppContext, chatId: string, args: string): Promise<string> {
  const binding = resolveBinding(ctx, chatId);
  const cwd = binding.workingDirectory || ctx.config.defaultWorkDir || process.cwd();

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

export async function cmdDiff(ctx: AppContext, chatId: string, args: string): Promise<string> {
  const binding = resolveBinding(ctx, chatId);
  const cwd = binding.workingDirectory || process.cwd();

  if (!fs.existsSync(cwd)) {
    return `Working directory does not exist: \`${cwd}\``;
  }

  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return `Not a git repository: \`${cwd}\``;
  }

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

export function cmdModels(ctx: AppContext, chatId: string, _args: string): string {
  const config = ctx.config;
  const binding = ctx.store.getChannelBinding(chatId);

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

export function cmdCost(ctx: AppContext, chatId: string, _args: string): string {
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

export function cmdRemember(args: string): string {
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

export function cmdRecall(args: string): string {
  const key = args.trim();
  if (key) {
    const entries = memory.readEntries();
    const entry = entries.find(e => e.key === key);
    if (entry) {
      return `**${entry.key}**\n${entry.value}`;
    }
    return `❌ 没找到: \`${key}\`\n\n用 \`/memories\` 看所有。`;
  }
  const all = memory.readAll();
  if (!all) {
    return '**(~/.claude/CLAUDE.md 是空的)**\n\n用 `/remember <key> <value>` 添加记忆';
  }
  const maxLen = 4000;
  const display = all.length > maxLen ? all.slice(0, maxLen) + `\n\n... (截断，共 ${all.length} 字符)` : all;
  return `**~/.claude/CLAUDE.md 完整内容:**\n\n\`\`\`\n${display}\n\`\`\``;
}

export function cmdForget(args: string): string {
  const key = args.trim();
  if (!key) {
    return 'Usage: `/forget <key>`';
  }
  const removed = memory.removeEntry(key);
  return removed
    ? `✓ 已忘记: \`${key}\``
    : `❌ 没找到: \`${key}\`\n\n用 \`/memories\` 看所有。`;
}

export function cmdMemories(): string {
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
