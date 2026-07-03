/**
 * FeishuCardManager — owns CardKit v2 streaming card lifecycle.
 *
 * Extracted from FeishuClient to keep card state (active cards, in-flight
 * card create promises) isolated from message processing. The manager
 * owns:
 *   - Card state (activeCards map)
 *   - In-flight card create promises (cardCreatePromises)
 *   - Throttle timer per card
 *
 * The host (FeishuClient) provides the rest client (lazy, may be null
 * before start()) and a small set of formatting helpers.
 */

import type { CardState, SendResult } from './feishu-types.js';
import { CARD_THROTTLE_MS } from './feishu-types.js';
import type { ToolCallInfo, TokenUsage } from './types.js';
import {
  buildStreamingContent,
  buildFinalCardJson,
  formatElapsed,
  formatTokenCount,
} from './feishu-markdown.js';

type RestClient = any;

export interface CardManagerDeps {
  getRestClient: () => RestClient | null;
  /** Log a warning that goes to bridge.log. */
  log?: (msg: string) => void;
}

export class FeishuCardManager {
  private activeCards = new Map<string, CardState>();
  private cardCreatePromises = new Map<string, Promise<boolean>>();

  constructor(private deps: CardManagerDeps) {}

  // ── Public API ──

  /** Create a streaming card and track its state. Idempotent per chatId. */
  createStreamingCard(chatId: string, replyToMessageId?: string): Promise<boolean> {
    const restClient = this.deps.getRestClient();
    if (!restClient || this.activeCards.has(chatId)) return Promise.resolve(false);
    const existing = this.cardCreatePromises.get(chatId);
    if (existing) return existing;

    const promise = this._doCreateStreamingCard(chatId, replyToMessageId);
    this.cardCreatePromises.set(chatId, promise);
    promise.finally(() => this.cardCreatePromises.delete(chatId));
    return promise;
  }

  /** Update the card's pending text. Auto-throttles to CARD_THROTTLE_MS. */
  updateCardContent(chatId: string, text: string): void {
    const restClient = this.deps.getRestClient();
    const state = this.activeCards.get(chatId);
    if (!state || !restClient) return;

    if (state.thinking && text.trim()) {
      state.thinking = false;
    }
    state.pendingText = text;

    const elapsed = Date.now() - state.lastUpdateAt;
    if (elapsed < CARD_THROTTLE_MS && state.lastUpdateAt > 0) {
      if (!state.throttleTimer) {
        state.throttleTimer = setTimeout(() => {
          state.throttleTimer = null;
          this.flushCardUpdate(chatId);
        }, CARD_THROTTLE_MS - elapsed);
      }
      return;
    }

    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }
    this.flushCardUpdate(chatId);
  }

  /** Update tool progress (will re-render via updateCardContent). */
  updateToolProgress(chatId: string, tools: ToolCallInfo[]): void {
    const state = this.activeCards.get(chatId);
    if (!state) return;
    state.toolCalls = tools;
    this.updateCardContent(chatId, state.pendingText || '');
  }

  /** Finalize the card: turn off streaming, set final content with footer. */
  async finalizeCard(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    tokenUsage?: TokenUsage | null,
  ): Promise<boolean> {
    const restClient = this.deps.getRestClient();
    const pending = this.cardCreatePromises.get(chatId);
    if (pending) {
      try { await pending; } catch { /* no card */ }
    }

    const state = this.activeCards.get(chatId);
    if (!state || !restClient) return false;

    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }

    try {
      state.sequence++;
      await (restClient as any).cardkit.v1.card.settings({
        path: { card_id: state.cardId },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence: state.sequence,
        },
      });

      const statusLabels: Record<string, string> = {
        completed: '✅ Completed',
        interrupted: '⚠️ Interrupted',
        error: '❌ Error',
      };
      const elapsedMs = Date.now() - state.startTime;
      const footer: { status: string; elapsed: string; tokens?: string; cost?: string; context?: string } = {
        status: statusLabels[status] || status,
        elapsed: formatElapsed(elapsedMs),
      };

      if (tokenUsage) {
        const inTok = tokenUsage.input_tokens ?? 0;
        const outTok = tokenUsage.output_tokens ?? 0;
        const cacheTok = (tokenUsage.cache_read_input_tokens ?? 0) + (tokenUsage.cache_creation_input_tokens ?? 0);
        footer.tokens = cacheTok > 0
          ? `↓${formatTokenCount(inTok)} ↑${formatTokenCount(outTok)} (cache ${formatTokenCount(cacheTok)})`
          : `↓${formatTokenCount(inTok)} ↑${formatTokenCount(outTok)}`;
        if (tokenUsage.cost_usd != null) {
          footer.cost = `$${tokenUsage.cost_usd.toFixed(4)}`;
        }
        const totalTokens = inTok + outTok;
        const CONTEXT_WINDOW_TOKENS = 200_000; // Claude Sonnet 4 context window
        const contextPct = (totalTokens / CONTEXT_WINDOW_TOKENS * 100).toFixed(1);
        footer.context = `${contextPct}%`;
      }

      const finalCardJson = buildFinalCardJson(responseText, state.toolCalls, footer);
      state.sequence++;
      await (restClient as any).cardkit.v1.card.update({
        path: { card_id: state.cardId },
        data: {
          card: { type: 'card_json', data: finalCardJson },
          sequence: state.sequence,
        },
      });

      console.log(`[feishu-card] Finalized: cardId=${state.cardId}, status=${status}, elapsed=${formatElapsed(elapsedMs)}`);
      return true;
    } catch (err: any) {
      const fv = err?.response?.data?.field_violations;
      if (fv) {
        console.warn('[feishu-card] Finalize field violations:', JSON.stringify(fv));
      }
      console.warn('[feishu-card] Finalize failed:', err instanceof Error ? err.message : err);
      return false;
    } finally {
      this.activeCards.delete(chatId);
    }
  }

  /** Drop card state without finalize (used on message end). */
  cleanupCard(chatId: string): void {
    this.cardCreatePromises.delete(chatId);
    const state = this.activeCards.get(chatId);
    if (!state) return;
    if (state.throttleTimer) clearTimeout(state.throttleTimer);
    this.activeCards.delete(chatId);
  }

  /** Clear all cards (used in stop()). */
  clearAll(): void {
    for (const [, state] of this.activeCards) {
      if (state.throttleTimer) clearTimeout(state.throttleTimer);
    }
    this.activeCards.clear();
    this.cardCreatePromises.clear();
  }

  hasActiveCard(chatId: string): boolean {
    return this.activeCards.has(chatId);
  }

  // ── Internal ──

  private flushCardUpdate(chatId: string): void {
    const restClient = this.deps.getRestClient();
    const state = this.activeCards.get(chatId);
    if (!state || !restClient) return;

    const elapsedMs = Date.now() - state.startTime;
    const content = buildStreamingContent(state.pendingText || '', state.toolCalls, elapsedMs);
    state.sequence++;
    const seq = state.sequence;
    const cardId = state.cardId;

    (restClient as any).cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: 'streaming_content' },
      data: { content, sequence: seq },
    }).then(() => {
      state.lastUpdateAt = Date.now();
    }).catch((err: unknown) => {
      console.warn('[feishu-card] streamContent failed:', err instanceof Error ? err.message : err);
    });
  }

  private async _doCreateStreamingCard(chatId: string, replyToMessageId?: string): Promise<boolean> {
    const restClient = this.deps.getRestClient();
    if (!restClient) return false;

    try {
      const cardBody = {
        schema: '2.0',
        config: {
          streaming_mode: true,
          wide_screen_mode: true,
          summary: { content: '思考中...' },
        },
        body: {
          elements: [{
            tag: 'markdown',
            content: '💭 Thinking...',
            text_align: 'left',
            text_size: 'normal',
            element_id: 'streaming_content',
          }],
        },
      };

      const createResp = await (restClient as any).cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify(cardBody) },
      });
      const cardId = createResp?.data?.card_id;
      if (!cardId) {
        console.warn('[feishu-card] Card create returned no card_id');
        return false;
      }

      const cardContent = JSON.stringify({ type: 'card', data: { card_id: cardId } });
      let msgResp;
      if (replyToMessageId) {
        msgResp = await restClient.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardContent, msg_type: 'interactive' },
        });
      } else {
        msgResp = await restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardContent,
          },
        });
      }

      const messageId = msgResp?.data?.message_id;
      if (!messageId) {
        console.warn('[feishu-card] Card message send returned no message_id');
        return false;
      }

      this.activeCards.set(chatId, {
        cardId,
        messageId,
        sequence: 0,
        startTime: Date.now(),
        toolCalls: [],
        thinking: true,
        pendingText: null,
        lastUpdateAt: 0,
        throttleTimer: null,
      });

      console.log(`[feishu-card] Created: cardId=${cardId}, msgId=${messageId}`);
      return true;
    } catch (err) {
      console.warn('[feishu-card] Failed to create streaming card:', err instanceof Error ? err.message : err);
      return false;
    }
  }
}
