/**
 * Feishu types and constants — shared by feishu.ts, feishu-card.ts, etc.
 *
 * No runtime logic, just types and immutable constants. Safe to import
 * from anywhere without side effects.
 */

import type { ToolCallInfo, TokenUsage, FileAttachment, InboundMessage } from './types.js';

// ── Constants ──

export const DEDUP_MAX = 1000;
export const MAX_FILE_SIZE = 20 * 1024 * 1024;  // 20MB
export const TYPING_EMOJI = 'Typing';
export const CARD_THROTTLE_MS = 200;

export const MIME_BY_TYPE: Record<string, string> = {
  image: 'image/png',
  file: 'application/octet-stream',
  audio: 'audio/ogg',
  video: 'video/mp4',
  media: 'application/octet-stream',
};

// ── Card state ──

/** State for an active CardKit v2 streaming card. */
export interface CardState {
  cardId: string;
  messageId: string;
  sequence: number;
  startTime: number;
  toolCalls: ToolCallInfo[];
  thinking: boolean;
  pendingText: string | null;
  lastUpdateAt: number;
  throttleTimer: ReturnType<typeof setTimeout> | null;
}

// ── Incoming event ──

export type FeishuMessageEventData = {
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; union_id?: string; user_id?: string };
      name: string;
    }>;
  };
};

// ── Outbound ──

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}
