/**
 * Claude Memory Bridge — read/write the bridge-managed section in
 * `~/.claude/CLAUDE.md`.
 *
 * Why: Claude Code CLI already auto-loads `~/.claude/CLAUDE.md` into its
 * system prompt. Instead of maintaining a separate KV store (which would
 * duplicate state and conflict with CLI /memory edits), we write into a
 * clearly-marked section of the same file:
 *
 *     <!-- BRIDGE_MEMORY_START -->
 *     ## language
 *     用中文回复
 *
 *     ## style
 *     简短直接
 *     <!-- BRIDGE_MEMORY_END -->
 *
 * - Only the section between the markers is touched — anything else in
 *   CLAUDE.md (CLI /memory edits, manual notes, project descriptions) is
 *   preserved byte-for-byte.
 * - Entries use `## <key>` heading + body, matching CLAUDE.md's natural
 *   markdown structure so CLI /memory editing tools see them as regular content.
 * - No file lock in Phase 1 (single user, low concurrency risk). Phase 2
 *   should add fcntl locking if we see race conditions with CLI /memory.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const BRIDGE_SECTION_START = '<!-- BRIDGE_MEMORY_START -->';
export const BRIDGE_SECTION_END = '<!-- BRIDGE_MEMORY_END -->';

export interface MemoryEntry {
  key: string;
  value: string;
}

const DEFAULT_CLAUDE_MD = path.join(os.homedir(), '.claude', 'CLAUDE.md');

export class ClaudeMemory {
  constructor(private filePath: string = DEFAULT_CLAUDE_MD) {}

  /** Full CLAUDE.md content. Empty string if file does not exist. */
  readAll(): string {
    try {
      return fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  /** Just the bridge-managed entries (between markers). */
  readEntries(): MemoryEntry[] {
    const section = extractBridgeSection(this.readAll());
    return parseEntries(section);
  }

  /** Add or update an entry. */
  setEntry(key: string, value: string): void {
    const content = this.readAll();
    const newContent = upsertEntry(content, key, value);
    writeFileAtomic(this.filePath, newContent);
  }

  /** Remove an entry by key. Returns true if something was removed. */
  removeEntry(key: string): boolean {
    const entries = this.readEntries();
    const filtered = entries.filter(e => e.key !== key);
    if (filtered.length === entries.length) return false;

    const content = this.readAll();
    const newContent = rebuildSection(content, filtered);
    writeFileAtomic(this.filePath, newContent);
    return true;
  }

  exists(): boolean {
    return fs.existsSync(this.filePath);
  }
}

// ── Internal helpers ──

function extractBridgeSection(content: string): string {
  const startIdx = content.indexOf(BRIDGE_SECTION_START);
  const endIdx = content.indexOf(BRIDGE_SECTION_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return '';
  return content.slice(startIdx + BRIDGE_SECTION_START.length, endIdx);
}

/**
 * Parse entries from the bridge section body.
 * Format: `## <key>` line followed by value lines until next `## ` or end.
 */
export function parseEntries(section: string): MemoryEntry[] {
  if (!section.trim()) return [];
  const entries: MemoryEntry[] = [];
  const lines = section.split('\n');
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (m) {
      const key = m[1];
      i++;
      const valueLines: string[] = [];
      while (i < lines.length && !lines[i].match(/^##\s+/)) {
        valueLines.push(lines[i]);
        i++;
      }
      const value = valueLines.join('\n').trim();
      if (key && value) entries.push({ key, value });
    } else {
      i++;
    }
  }
  return entries;
}

/** Upsert key→value in the bridge section; create section if missing. */
export function upsertEntry(content: string, key: string, value: string): string {
  const startIdx = content.indexOf(BRIDGE_SECTION_START);
  const endIdx = content.indexOf(BRIDGE_SECTION_END);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    // No section yet — append to end
    const sep = content.endsWith('\n') || content === '' ? '\n' : '\n\n';
    return (
      content +
      sep +
      BRIDGE_SECTION_START + '\n\n' +
      '## ' + key + '\n' + value + '\n\n' +
      BRIDGE_SECTION_END + '\n'
    );
  }

  // Section exists — upsert inside, preserve everything outside byte-for-byte
  const before = content.slice(0, startIdx + BRIDGE_SECTION_START.length);
  const innerSection = content.slice(startIdx + BRIDGE_SECTION_START.length, endIdx);
  const after = content.slice(endIdx);

  const entries = parseEntries(innerSection);
  const idx = entries.findIndex(e => e.key === key);
  if (idx >= 0) entries[idx] = { key, value };
  else entries.push({ key, value });

  const newInner = '\n\n' + entries.map(formatEntry).join('\n\n') + '\n\n';
  return before + newInner + after;
}

/** Rebuild section from filtered entries; remove section if empty. */
export function rebuildSection(content: string, entries: MemoryEntry[]): string {
  const startIdx = content.indexOf(BRIDGE_SECTION_START);
  const endIdx = content.indexOf(BRIDGE_SECTION_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return content;

  // `beforePart` = content up to (but not including) the start marker.
  // Trim its trailing newlines down to a single \n separator.
  const beforePart = content.slice(0, startIdx).replace(/\n+$/, '\n');

  if (entries.length === 0) {
    // Remove the entire section including surrounding blank lines.
    // `afterPart` = content after the end marker, stripped of leading newlines.
    const afterPart = content.slice(endIdx + BRIDGE_SECTION_END.length).replace(/^\n+/, '');
    return beforePart + afterPart;
  }

  const newInner = '\n\n' + entries.map(formatEntry).join('\n\n') + '\n\n';
  const afterPart = content.slice(endIdx + BRIDGE_SECTION_END.length);
  return beforePart + BRIDGE_SECTION_START + newInner + BRIDGE_SECTION_END + afterPart;
}

function formatEntry(e: MemoryEntry): string {
  return '## ' + e.key + '\n' + e.value;
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}
