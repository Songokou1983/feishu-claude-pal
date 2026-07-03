/**
 * Bridge helpers — shared utilities for the message orchestration layer.
 *
 * Exports pure-ish helpers and module-level state that bridge.ts and
 * bridge-commands.ts share. No business logic — just plumbing.
 */

import type { AppContext, ChannelBinding } from './types.js';

// ── Per-chat /list cache (5 min TTL) ──────────────────────────

import type { CliSessionInfo } from './types.js';

interface ListCacheEntry {
  sessions: CliSessionInfo[];
  cachedAt: number;
}

export const LIST_CACHE_TTL = 5 * 60 * 1000;
const listCache = new Map<string, ListCacheEntry>();

export function getCachedList(chatId: string): CliSessionInfo[] | null {
  const entry = listCache.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > LIST_CACHE_TTL) {
    listCache.delete(chatId);
    return null;
  }
  return entry.sessions;
}

export function setCachedList(chatId: string, sessions: CliSessionInfo[]): void {
  listCache.set(chatId, { sessions, cachedAt: Date.now() });
}

// ── Session locks (concurrency control per codepilot session) ─

const sessionLocks = new Map<string, Promise<void>>();

export function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
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

// ── Active task abort controllers (per codepilot session) ──────

const activeTasks = new Map<string, AbortController>();

export function setActiveTask(sessionId: string, controller: AbortController): void {
  activeTasks.set(sessionId, controller);
}

export function getActiveTask(sessionId: string): AbortController | undefined {
  return activeTasks.get(sessionId);
}

export function deleteActiveTask(sessionId: string): void {
  activeTasks.delete(sessionId);
}

// ── Numeric permission shortcut (1/2/3 reply detection) ──────

export function isNumericPermissionShortcut(ctx: AppContext, rawText: string, chatId: string): boolean {
  const normalized = rawText.normalize('NFKC').replace(/[​-‍﻿]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const pending = ctx.store.listPendingPermissionLinksByChat(chatId);
  return pending.length > 0;
}

// ── Binding resolution (per-chat → channel binding) ───────────

export function resolveBinding(ctx: AppContext, chatId: string): ChannelBinding {
  const existing = ctx.store.getChannelBinding(chatId);
  if (existing) {
    const session = ctx.store.getSession(existing.codepilotSessionId);
    if (session) return existing;
  }
  return createNewBinding(ctx, chatId);
}

export function createNewBinding(ctx: AppContext, chatId: string, workDir?: string): ChannelBinding {
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

// ── SDK session ID update logic ──────────────────────────────

export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId && !hasError) return sdkSessionId;
  if (hasError) return '';
  return null;
}

// ── CLI session helpers (/list, /resume) ─────────────────────

export function findCliSession(ctx: AppContext, query: string): CliSessionInfo | null {
  const sessions = ctx.store.listCliSessions({ limit: 50 });
  const q = query.toLowerCase();
  const byId = sessions.find(s => s.sdkSessionId.toLowerCase().startsWith(q));
  if (byId) return byId;
  const bySlug = sessions.find(s => s.slug.toLowerCase() === q);
  return bySlug || null;
}

export function resumeCliSession(ctx: AppContext, chatId: string, target: CliSessionInfo): string {
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
