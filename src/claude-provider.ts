/**
 * Claude Provider — wraps @anthropic-ai/claude-agent-sdk query() function.
 *
 * Converts SDK stream events into SSE format consumed by the conversation engine.
 * Stripped of Codex logic, non-Claude model guard, strict env mode, and multi-candidate
 * preflight scanning.
 */

import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { PendingPermissions } from './permissions.js';
import type { StreamChatParams, FileAttachment } from './types.js';

// ── SSE helper ──

function sseEvent(type: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `data: ${JSON.stringify({ type, data: payload })}\n`;
}

// ── Environment isolation ──

const ENV_ALWAYS_STRIP = ['CLAUDECODE'];

export function buildSubprocessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_ALWAYS_STRIP.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

// ── Error classification ──

const CLI_AUTH_PATTERNS = [
  /not logged in/i,
  /please run \/login/i,
  /loggedIn['":\s]*false/i,
];

const API_AUTH_PATTERNS = [
  /unauthorized/i,
  /invalid.*api.?key/i,
  /authentication.*failed/i,
  /does not have access/i,
  /401\b/,
];

const RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /rate.?limit/i,
  /too many requests/i,
  /quota exceeded/i,
];

const NETWORK_PATTERNS = [
  /ECONNREFUSED/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /ENETUNREACH/,
  /EAI_AGAIN/,
  /socket hang up/i,
  /\btimeout\b/i,
  /\bnetwork\b/i,
  /fetch failed/i,
];

const MODEL_NOT_FOUND_PATTERNS = [
  /\b404\b.*\bmodel\b/i,
  /model.*not.*found/i,
  /unknown model/i,
  /model.*does not exist/i,
  /invalid model/i,
];

const CONTEXT_TOO_LONG_PATTERNS = [
  /context.*length.*exceed/i,
  /too many tokens/i,
  /maximum context/i,
  /prompt is too long/i,
  /context_window_exceeded/i,
  /\b413\b/,
];

const PERMISSION_DENIED_PATTERNS = [
  /\b403\b/,
  /permission.*denied/i,
  /forbidden/i,
  /not authorized/i,
];

export type AuthErrorKind = 'cli' | 'api' | false;
export type ErrorKind =
  | 'auth_cli'
  | 'auth_api'
  | 'rate_limit'
  | 'network'
  | 'model_not_found'
  | 'context_too_long'
  | 'permission_denied'
  | 'unknown';

export function classifyAuthError(text: string): AuthErrorKind {
  if (CLI_AUTH_PATTERNS.some(re => re.test(text))) return 'cli';
  if (API_AUTH_PATTERNS.some(re => re.test(text))) return 'api';
  return false;
}

/** Comprehensive error classifier. Replaces ad-hoc classifyAuthError() calls. */
export function classifyError(text: string): ErrorKind {
  if (CLI_AUTH_PATTERNS.some(re => re.test(text))) return 'auth_cli';
  if (API_AUTH_PATTERNS.some(re => re.test(text))) return 'auth_api';
  if (RATE_LIMIT_PATTERNS.some(re => re.test(text))) return 'rate_limit';
  if (NETWORK_PATTERNS.some(re => re.test(text))) return 'network';
  if (MODEL_NOT_FOUND_PATTERNS.some(re => re.test(text))) return 'model_not_found';
  if (CONTEXT_TOO_LONG_PATTERNS.some(re => re.test(text))) return 'context_too_long';
  if (PERMISSION_DENIED_PATTERNS.some(re => re.test(text))) return 'permission_denied';
  return 'unknown';
}

const CLI_AUTH_USER_MESSAGE =
  'Claude CLI is not logged in. Run `claude auth login`, then restart the bridge.';

const API_AUTH_USER_MESSAGE =
  'API credential error. Check your ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN in config.env, ' +
  'or verify your organization has access to the requested model.';

const RATE_LIMIT_USER_MESSAGE = (raw: string) =>
  `**Rate limit hit** — 请求频率过高，请稍等几秒再试。\n\n` +
  `原始错误: \`${raw.slice(0, 200)}\``;

const NETWORK_USER_MESSAGE = (raw: string) =>
  `**Network error** — 网络连接失败。\n\n` +
  `可能原因:\n` +
  `• 网络中断或代理失效\n` +
  `• Base URL 不可达 (检查 ANTHROPIC_BASE_URL / MINIMAX_BASE_URL / GLM_BASE_URL)\n` +
  `• DNS 解析失败\n\n` +
  `原始错误: \`${raw.slice(0, 200)}\``;

const MODEL_NOT_FOUND_USER_MESSAGE = (raw: string) =>
  `**Model not found** — 模型名/Base URL 配错。\n\n` +
  `检查:\n` +
  `• \`/models\` 看当前已配供应商\n` +
  `• config.env 里 MINIMAX_BASE_URL / GLM_BASE_URL 是否填对\n` +
  `• \`/model <key>\` 切到正确的供应商\n\n` +
  `原始错误: \`${raw.slice(0, 200)}\``;

const CONTEXT_TOO_LONG_USER_MESSAGE = (raw: string) =>
  `**Context too long** — 当前会话超出模型上下文窗口。\n\n` +
  `建议:\n` +
  `• \`/new\` 开新会话\n` +
  `• 或把上下文压缩到几条关键消息\n\n` +
  `原始错误: \`${raw.slice(0, 200)}\``;

const PERMISSION_DENIED_USER_MESSAGE = (raw: string) =>
  `**Permission denied** — API key 无权访问此模型或资源。\n\n` +
  `检查 organization 是否开通了该模型访问权限，或换用 default 模型。\n\n` +
  `原始错误: \`${raw.slice(0, 200)}\``;

function getUserMessageForKind(kind: ErrorKind, raw: string): string {
  switch (kind) {
    case 'auth_cli': return CLI_AUTH_USER_MESSAGE;
    case 'auth_api': return API_AUTH_USER_MESSAGE;
    case 'rate_limit': return RATE_LIMIT_USER_MESSAGE(raw);
    case 'network': return NETWORK_USER_MESSAGE(raw);
    case 'model_not_found': return MODEL_NOT_FOUND_USER_MESSAGE(raw);
    case 'context_too_long': return CONTEXT_TOO_LONG_USER_MESSAGE(raw);
    case 'permission_denied': return PERMISSION_DENIED_USER_MESSAGE(raw);
    default: return raw;
  }
}

// ── Claude CLI path resolution ──

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseCliMajorVersion(versionOutput: string): number | undefined {
  const m = versionOutput.match(/(\d+)\.\d+/);
  return m ? parseInt(m[1], 10) : undefined;
}

function getCliVersion(cliPath: string, env?: Record<string, string>): string | undefined {
  try {
    return execSync(`"${cliPath}" --version`, {
      encoding: 'utf-8',
      timeout: 10_000,
      env: env || buildSubprocessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

const MIN_CLI_MAJOR = 2;
const REQUIRED_CLI_FLAGS = ['output-format', 'input-format', 'permission-mode', 'setting-sources'];

function checkRequiredFlags(cliPath: string, env?: Record<string, string>): string[] {
  let helpText: string;
  try {
    helpText = execSync(`"${cliPath}" --help`, {
      encoding: 'utf-8',
      timeout: 10_000,
      env: env || buildSubprocessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return [];
  }
  return REQUIRED_CLI_FLAGS.filter(flag => !helpText.includes(flag));
}

function checkCliCompatibility(cliPath: string, env?: Record<string, string>): {
  compatible: boolean;
  version: string;
  major: number | undefined;
  missingFlags?: string[];
} | undefined {
  const version = getCliVersion(cliPath, env);
  if (!version) return undefined;
  const major = parseCliMajorVersion(version);
  if (major === undefined || major < MIN_CLI_MAJOR) {
    return { compatible: false, version, major };
  }
  const missing = checkRequiredFlags(cliPath, env);
  return {
    compatible: missing.length === 0,
    version,
    major,
    missingFlags: missing.length > 0 ? missing : undefined,
  };
}

export function preflightCheck(cliPath: string): { ok: boolean; version?: string; error?: string } {
  const cleanEnv = buildSubprocessEnv();
  const compat = checkCliCompatibility(cliPath, cleanEnv);
  if (!compat) {
    return { ok: false, error: `claude CLI at "${cliPath}" failed to execute` };
  }
  if (compat.major !== undefined && compat.major < MIN_CLI_MAJOR) {
    return {
      ok: false,
      version: compat.version,
      error: `claude CLI version ${compat.version} is too old (need >= ${MIN_CLI_MAJOR}.x).`,
    };
  }
  if (compat.missingFlags) {
    return {
      ok: false,
      version: compat.version,
      error: `claude CLI ${compat.version} is missing required flags: ${compat.missingFlags.join(', ')}.`,
    };
  }
  return { ok: true, version: compat.version };
}

function findAllInPath(): string[] {
  if (process.platform === 'win32') {
    try {
      return execSync('where claude', { encoding: 'utf-8', timeout: 3000 })
        .trim().split('\n').map(s => s.trim()).filter(Boolean);
    } catch { return []; }
  }
  try {
    return execSync('which -a claude', { encoding: 'utf-8', timeout: 3000 })
      .trim().split('\n').map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

export function resolveClaudeCliPath(): string | undefined {
  const fromEnv = process.env.CTI_CLAUDE_CODE_EXECUTABLE;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;

  const pathCandidates = findAllInPath();
  const wellKnown = [
    `${process.env.HOME}/.claude/local/claude`,
    `${process.env.HOME}/.local/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];

  const seen = new Set<string>();
  const allCandidates: string[] = [];
  for (const p of [...pathCandidates, ...wellKnown]) {
    if (p && !seen.has(p)) {
      seen.add(p);
      allCandidates.push(p);
    }
  }

  let firstUnverifiable: string | undefined;
  for (const p of allCandidates) {
    if (!isExecutable(p)) continue;
    const compat = checkCliCompatibility(p);
    if (compat?.compatible) {
      if (p !== pathCandidates[0] && pathCandidates.length > 0) {
        console.log(`[claude-provider] Skipping incompatible CLI at "${pathCandidates[0]}", using "${p}" (${compat.version})`);
      }
      return p;
    }
    if (compat) {
      console.warn(`[claude-provider] CLI at "${p}" is version ${compat.version} (need >= ${MIN_CLI_MAJOR}.x), skipping`);
    } else if (!firstUnverifiable) {
      firstUnverifiable = p;
    }
  }

  return firstUnverifiable;
}

// ── Multi-modal prompt builder ──

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
const SUPPORTED_IMAGE_TYPES = new Set<string>([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
]);

function buildPrompt(
  text: string,
  files?: FileAttachment[],
): string | AsyncIterable<{ type: 'user'; message: { role: 'user'; content: unknown[] }; parent_tool_use_id: null; session_id: string }> {
  const imageFiles = files?.filter(f => SUPPORTED_IMAGE_TYPES.has(f.type));
  if (!imageFiles || imageFiles.length === 0) return text;

  const contentBlocks: unknown[] = [];
  for (const file of imageFiles) {
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: (file.type === 'image/jpg' ? 'image/jpeg' : file.type) as ImageMediaType,
        data: file.data,
      },
    });
  }
  if (text.trim()) {
    contentBlocks.push({ type: 'text', text });
  }

  const msg = {
    type: 'user' as const,
    message: { role: 'user' as const, content: contentBlocks },
    parent_tool_use_id: null,
    session_id: '',
  };
  return (async function* () { yield msg; })();
}

// ── Stream state ──

interface StreamState {
  hasReceivedResult: boolean;
  hasStreamedText: boolean;
  lastAssistantText: string;
}

// ── ClaudeProvider ──

export interface ClaudeProviderConfig {
  cliPath?: string;
  autoApprove?: boolean;
  defaultModel?: string;
  minimaxBaseUrl?: string;
  minimaxAuthToken?: string;
  glmBaseUrl?: string;
  glmApiKey?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
}

function isGlmModel(modelName: string): boolean {
  return modelName === 'glm-5.1' || modelName.startsWith('glm');
}

/** Map bridge-side model alias to CLI model + inject provider env vars. */
function resolveModelForQuery(
  modelName: string | undefined,
  config: ClaudeProviderConfig,
  cleanEnv: Record<string, string>,
): string | undefined {
  if (!modelName) return undefined;

  if (isGlmModel(modelName)) {
    if (config.glmBaseUrl && config.glmApiKey) {
      cleanEnv.ANTHROPIC_BASE_URL = config.glmBaseUrl;
      cleanEnv.ANTHROPIC_AUTH_TOKEN = config.glmApiKey;
      cleanEnv.ANTHROPIC_API_KEY = config.glmApiKey;
      console.log(`[claude-provider] Using GLM provider (model: ${modelName})`);
      return modelName;
    }
    console.warn('[claude-provider] GLM model selected but GLM_BASE_URL/GLM_API_KEY not configured');
    return modelName;
  }

  if (modelName === 'minimax') {
    if (config.minimaxBaseUrl && config.minimaxAuthToken) {
      cleanEnv.ANTHROPIC_BASE_URL = config.minimaxBaseUrl;
      cleanEnv.ANTHROPIC_AUTH_TOKEN = config.minimaxAuthToken;
      cleanEnv.ANTHROPIC_API_KEY = config.minimaxAuthToken;
      console.log('[claude-provider] Using MiniMax provider');
      return undefined;
    }
    console.warn('[claude-provider] MiniMax model selected but MINIMAX_* not configured');
    return undefined;
  }

  return modelName;
}

/**
 * Build MCP server configs to attach to every Claude query.
 * Currently wires up Feishu-MCP so Claude can read/write Feishu docs and
 * browse Drive (tenant auth, modules=document,drive).
 * See https://github.com/cso1z/Feishu-MCP
 */
interface McpStdioServer {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
}

function buildMcpServers(config: ClaudeProviderConfig): Record<string, McpStdioServer> | undefined {
  if (!config.feishuAppId || !config.feishuAppSecret) {
    return undefined;
  }
  return {
    feishu: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'feishu-mcp@latest', '--stdio'],
      env: {
        FEISHU_APP_ID: config.feishuAppId,
        FEISHU_APP_SECRET: config.feishuAppSecret,
        FEISHU_AUTH_TYPE: 'tenant',
        FEISHU_ENABLED_MODULES: 'document,drive',
      },
    },
  };
}

export class ClaudeProvider {
  constructor(
    private pendingPerms: PendingPermissions,
    private config: ClaudeProviderConfig,
  ) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const pendingPerms = this.pendingPerms;
    const config = this.config;
    const autoApprove = config.autoApprove;

    return new ReadableStream({
      start(controller) {
        (async () => {
          const MAX_STDERR = 4096;
          let stderrBuf = '';
          const state: StreamState = { hasReceivedResult: false, hasStreamedText: false, lastAssistantText: '' };

          try {
            const cleanEnv = buildSubprocessEnv();

            const model = resolveModelForQuery(
              params.model || config.defaultModel,
              config,
              cleanEnv,
            );

            const mcpServers = buildMcpServers(config);
            const queryOptions: Record<string, unknown> = {
              cwd: params.workingDirectory,
              model,
              resume: params.sdkSessionId || undefined,
              abortController: params.abortController,
              permissionMode: (params.permissionMode as 'default' | 'acceptEdits' | 'plan') || undefined,
              includePartialMessages: true,
              env: cleanEnv,
              ...(mcpServers ? { mcpServers } : {}),
              stderr: (data: string) => {
                stderrBuf += data;
                if (stderrBuf.length > MAX_STDERR) {
                  stderrBuf = stderrBuf.slice(-MAX_STDERR);
                }
              },
              canUseTool: async (
                toolName: string,
                input: Record<string, unknown>,
                opts: { toolUseID: string; suggestions?: string[] },
              ): Promise<PermissionResult> => {
                if (autoApprove) {
                  return { behavior: 'allow' as const, updatedInput: input };
                }
                controller.enqueue(
                  sseEvent('permission_request', {
                    permissionRequestId: opts.toolUseID,
                    toolName,
                    toolInput: input,
                    suggestions: opts.suggestions || [],
                  }),
                );
                const result = await pendingPerms.waitFor(opts.toolUseID);
                if (result.behavior === 'allow') {
                  return { behavior: 'allow' as const, updatedInput: input };
                }
                return {
                  behavior: 'deny' as const,
                  message: result.message || 'Denied by user',
                };
              },
            };
            if (config.cliPath) {
              queryOptions.pathToClaudeCodeExecutable = config.cliPath;
            }

            const prompt = buildPrompt(params.prompt, params.files);
            const q = query({
              prompt: prompt as Parameters<typeof query>[0]['prompt'],
              options: queryOptions as Parameters<typeof query>[0]['options'],
            });

            for await (const msg of q) {
              handleMessage(msg, controller, state);
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[claude-provider] SDK query error:', err instanceof Error ? err.stack || err.message : err);
            if (stderrBuf) {
              console.error('[claude-provider] stderr from CLI:', stderrBuf.trim());
            }

            const isTransportExit = message.includes('process exited with code');

            if (state.hasReceivedResult && isTransportExit) {
              console.log('[claude-provider] Suppressing transport error — result already received');
              controller.close();
              return;
            }

            if (state.lastAssistantText && classifyAuthError(state.lastAssistantText)) {
              controller.enqueue(sseEvent('text', state.lastAssistantText));
              controller.close();
              return;
            }

            const errorKind = classifyError(message) !== 'unknown'
              ? classifyError(message)
              : classifyError(stderrBuf);
            let userMessage: string;
            if (errorKind !== 'unknown') {
              userMessage = getUserMessageForKind(errorKind, message);
            } else if (isTransportExit) {
              const stderrSummary = stderrBuf.trim();
              const lines = [message];
              if (stderrSummary) {
                lines.push('', 'CLI stderr:', stderrSummary.slice(-1024));
              }
              lines.push(
                '',
                'Possible causes:',
                '• Claude CLI not authenticated — run: claude auth login',
                '• Claude CLI version too old (need >= 2.x) — run: claude --version',
                '• Missing ANTHROPIC_* env vars in daemon — check config.env',
              );
              userMessage = lines.join('\n');
            } else {
              userMessage = message;
            }

            controller.enqueue(sseEvent('error', userMessage));
            controller.close();
          }
        })();
      },
    });
  }
}

function handleMessage(
  msg: SDKMessage,
  controller: ReadableStreamDefaultController<string>,
  state: StreamState,
): void {
  switch (msg.type) {
    case 'stream_event': {
      const event = msg.event;
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        controller.enqueue(sseEvent('text', event.delta.text));
        state.hasStreamedText = true;
      }
      if (
        event.type === 'content_block_start' &&
        event.content_block.type === 'tool_use'
      ) {
        controller.enqueue(
          sseEvent('tool_use', {
            id: event.content_block.id,
            name: event.content_block.name,
            input: {},
          }),
        );
      }
      break;
    }

    case 'assistant': {
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            state.lastAssistantText += (state.lastAssistantText ? '\n' : '') + block.text;
          } else if (block.type === 'tool_use') {
            controller.enqueue(
              sseEvent('tool_use', {
                id: block.id,
                name: block.name,
                input: block.input,
              }),
            );
          }
        }
      }
      break;
    }

    case 'user': {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const rb = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
            const text = typeof rb.content === 'string'
              ? rb.content
              : JSON.stringify(rb.content ?? '');
            controller.enqueue(
              sseEvent('tool_result', {
                tool_use_id: rb.tool_use_id,
                content: text,
                is_error: rb.is_error || false,
              }),
            );
          }
        }
      }
      break;
    }

    case 'result': {
      state.hasReceivedResult = true;
      if (msg.subtype === 'success') {
        controller.enqueue(
          sseEvent('result', {
            session_id: msg.session_id,
            is_error: msg.is_error,
            usage: {
              input_tokens: msg.usage.input_tokens,
              output_tokens: msg.usage.output_tokens,
              cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
              cost_usd: msg.total_cost_usd,
            },
          }),
        );
      } else {
        const errors =
          'errors' in msg && Array.isArray(msg.errors)
            ? msg.errors.join('; ')
            : 'Unknown error';
        controller.enqueue(sseEvent('error', errors));
      }
      break;
    }

    case 'system': {
      if (msg.subtype === 'init') {
        controller.enqueue(
          sseEvent('status', {
            session_id: msg.session_id,
            model: msg.model,
          }),
        );
      }
      break;
    }

    default:
      break;
  }
}
