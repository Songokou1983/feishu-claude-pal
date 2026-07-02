/**
 * Unit tests for feishu-claude-bridge-v2.
 * Tests pure-logic modules without requiring Feishu or Claude connections.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Config ──────────────────────────────────────────────────

describe('config', async () => {
  const { loadConfig, CTI_HOME } = await import('../config.js');

  test('loadConfig returns valid config from existing config.env', () => {
    const config = loadConfig();
    assert.ok(config.feishuAppId, 'feishuAppId should be non-empty');
    assert.ok(config.feishuAppSecret, 'feishuAppSecret should be non-empty');
    assert.equal(typeof config.defaultWorkDir, 'string');
    assert.equal(typeof config.defaultMode, 'string');
    assert.equal(typeof config.feishuRequireMention, 'boolean');
  });

  test('CTI_HOME is set', () => {
    assert.ok(CTI_HOME, 'CTI_HOME should be defined');
  });
});

// ── Validators ──────────────────────────────────────────────

describe('validators', async () => {
  const {
    validateWorkingDirectory,
    validateSessionId,
    isDangerousInput,
    sanitizeInput,
    validateMode,
  } = await import('../validators.js');

  test('validateWorkingDirectory accepts absolute paths', () => {
    assert.equal(validateWorkingDirectory('/Users/test'), '/Users/test');
    assert.equal(validateWorkingDirectory('/tmp'), '/tmp');
  });

  test('validateWorkingDirectory rejects relative paths', () => {
    assert.equal(validateWorkingDirectory('relative/path'), null);
  });

  test('validateWorkingDirectory rejects traversal', () => {
    assert.equal(validateWorkingDirectory('/foo/../bar'), null);
  });

  test('validateWorkingDirectory rejects empty', () => {
    assert.equal(validateWorkingDirectory(''), null);
  });

  test('validateSessionId accepts valid UUIDs', () => {
    assert.ok(validateSessionId('a1b2c3d4-e5f6-7890-abcd-ef1234567890'));
    assert.ok(validateSessionId('a1b2c3d4e5f67890abcdef1234567890'));
  });

  test('validateSessionId rejects short strings', () => {
    assert.ok(!validateSessionId('abc'));
    assert.ok(!validateSessionId(''));
  });

  test('isDangerousInput flags null bytes', () => {
    const result = isDangerousInput('hello\x00world');
    assert.ok(result.dangerous);
  });

  test('isDangerousInput flags command substitution', () => {
    const result = isDangerousInput('$(rm -rf /)');
    assert.ok(result.dangerous);
  });

  test('isDangerousInput passes normal text', () => {
    const result = isDangerousInput('Hello Claude, please help me write a function');
    assert.ok(!result.dangerous);
  });

  test('sanitizeInput truncates long input', () => {
    const long = 'a'.repeat(50000);
    const { text, truncated } = sanitizeInput(long, 1000);
    assert.equal(text.length, 1000);
    assert.ok(truncated);
  });

  test('sanitizeInput strips control chars', () => {
    const { text } = sanitizeInput('hello\x00\x01world');
    assert.equal(text, 'helloworld');
  });

  test('validateMode accepts valid modes', () => {
    assert.ok(validateMode('code'));
    assert.ok(validateMode('plan'));
    assert.ok(validateMode('ask'));
  });

  test('validateMode rejects invalid modes', () => {
    assert.ok(!validateMode('invalid'));
    assert.ok(!validateMode(''));
  });
});

// ── Feishu Markdown ─────────────────────────────────────────

describe('feishu-markdown', async () => {
  const {
    hasComplexMarkdown,
    preprocessFeishuMarkdown,
    buildCardContent,
    buildPostContent,
    htmlToFeishuMarkdown,
    buildToolProgressMarkdown,
    formatElapsed,
    formatTokenCount,
    buildStreamingContent,
    buildFinalCardJson,
    buildPermissionButtonCard,
  } = await import('../feishu-markdown.js');

  test('hasComplexMarkdown detects code blocks', () => {
    assert.ok(hasComplexMarkdown('```js\nconst x = 1;\n```'));
    assert.ok(!hasComplexMarkdown('simple text'));
  });

  test('hasComplexMarkdown detects tables', () => {
    assert.ok(hasComplexMarkdown('| A | B |\n|---|---|\n| 1 | 2 |'));
    assert.ok(!hasComplexMarkdown('just | a | pipe'));
  });

  test('preprocessFeishuMarkdown ensures newline before code fences', () => {
    const result = preprocessFeishuMarkdown('text```code```');
    assert.ok(result.includes('text\n```'));
  });

  test('buildCardContent returns valid JSON', () => {
    const json = buildCardContent('hello');
    const parsed = JSON.parse(json);
    assert.equal(parsed.schema, '2.0');
    assert.ok(parsed.body.elements[0].content.includes('hello'));
  });

  test('buildPostContent returns valid post JSON', () => {
    const json = buildPostContent('hello');
    const parsed = JSON.parse(json);
    assert.ok(parsed.zh_cn);
    assert.ok(parsed.zh_cn.content[0][0].text === 'hello');
  });

  test('htmlToFeishuMarkdown converts HTML tags', () => {
    assert.equal(htmlToFeishuMarkdown('<b>bold</b>'), '**bold**');
    assert.equal(htmlToFeishuMarkdown('<i>italic</i>'), '*italic*');
    assert.equal(htmlToFeishuMarkdown('<code>code</code>'), '`code`');
    assert.ok(htmlToFeishuMarkdown('&amp;').includes('&'));
  });

  test('formatElapsed handles milliseconds', () => {
    assert.equal(formatElapsed(500), '500ms');
  });

  test('formatElapsed handles seconds', () => {
    assert.equal(formatElapsed(1500), '1.5s');
  });

  test('formatElapsed handles minutes', () => {
    assert.match(formatElapsed(125000), /2m/);
  });

  test('formatTokenCount formats thousands', () => {
    assert.equal(formatTokenCount(500), '500');
    assert.equal(formatTokenCount(1500), '1.5K');
    assert.equal(formatTokenCount(15000), '15K');
  });

  test('buildToolProgressMarkdown renders tool list', () => {
    const md = buildToolProgressMarkdown([
      { id: '1', name: 'Read', status: 'complete' },
      { id: '2', name: 'Write', status: 'running' },
    ]);
    assert.ok(md.includes('✅'));
    assert.ok(md.includes('🔄'));
    assert.ok(md.includes('Read'));
    assert.ok(md.includes('Write'));
  });

  test('buildStreamingContent returns thinking placeholder when empty', () => {
    assert.equal(buildStreamingContent('', []), '💭 Thinking...');
  });

  test('buildStreamingContent includes text and tools', () => {
    const content = buildStreamingContent('hello', [
      { id: '1', name: 'Read', status: 'running' },
    ]);
    assert.ok(content.includes('hello'));
    assert.ok(content.includes('Read'));
  });

  test('buildFinalCardJson returns valid card JSON', () => {
    const json = buildFinalCardJson('response text', [], {
      status: '✅ Completed',
      elapsed: '2.1s',
      tokens: '↓1K ↑500',
    });
    const parsed = JSON.parse(json);
    assert.equal(parsed.schema, '2.0');
    assert.ok(parsed.body.elements.length >= 1);
  });

  test('buildPermissionButtonCard returns valid card with buttons', () => {
    const json = buildPermissionButtonCard('**Permission**\nTool: `Read`', 'perm-123', 'chat-456');
    const parsed = JSON.parse(json);
    assert.equal(parsed.schema, '2.0');
    assert.ok(parsed.header);
    assert.ok(parsed.body.elements.length > 0);
    // Should contain column_set with buttons
    const columnSet = parsed.body.elements.find((e: any) => e.tag === 'column_set');
    assert.ok(columnSet, 'Should have column_set with buttons');
  });

  // B2-1: realtime elapsed in streaming content
  test('buildStreamingContent shows elapsed when provided', () => {
    const content = buildStreamingContent('hello', [], 12_345);
    assert.ok(content.includes('hello'), 'should include text');
    assert.ok(content.includes('⏱'), 'should include clock emoji');
    assert.ok(content.includes('12.3s'), 'should show formatted elapsed');
  });

  test('buildStreamingContent shows elapsed with thinking indicator', () => {
    const content = buildStreamingContent('', [], 500);
    assert.ok(content.includes('Thinking'), 'should show thinking');
    assert.ok(content.includes('⏱'), 'should include clock');
    assert.ok(content.includes('500ms'), 'should show ms when <1s');
  });

  test('buildStreamingContent omits elapsed when not provided (back-compat)', () => {
    const content = buildStreamingContent('hello', []);
    assert.ok(content.includes('hello'));
    assert.ok(!content.includes('⏱'), 'should NOT include clock when no elapsed');
  });

  test('buildStreamingContent omits elapsed when 0', () => {
    const content = buildStreamingContent('hello', [], 0);
    assert.ok(!content.includes('⏱'), 'should NOT include clock when elapsed=0');
  });
});

// ── Store ───────────────────────────────────────────────────

describe('store', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');

  // Use a temp directory to avoid touching real data
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  process.env.CTI_HOME = tmpDir;

  // Need to re-import after setting CTI_HOME
  // Actually the store imports CTI_HOME at module load time from config.ts
  // which reads process.env.CTI_HOME. But the module is already cached.
  // Let's test with the real store against a temp config.

  const { loadConfig } = await import('../config.js');
  const { JsonFileStore } = await import('../store.js');

  // Create minimal config.env in temp dir
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'data', 'messages'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'config.env'), 'CTI_DEFAULT_WORKDIR=/tmp\nCTI_DEFAULT_MODE=code\n');

  const config = loadConfig();

  test('JsonFileStore can be constructed', () => {
    const store = new JsonFileStore(config);
    assert.ok(store);
  });

  test('createSession and getSession', () => {
    const store = new JsonFileStore(config);
    const session = store.createSession('test', 'claude-3', undefined, '/tmp');
    assert.ok(session.id);
    assert.equal(session.working_directory, '/tmp');
    assert.equal(session.model, 'claude-3');

    const retrieved = store.getSession(session.id);
    assert.ok(retrieved);
    assert.equal(retrieved!.id, session.id);
  });

  test('upsertChannelBinding and getChannelBinding', () => {
    const store = new JsonFileStore(config);
    const session = store.createSession('test', '', undefined, '/tmp');

    const binding = store.upsertChannelBinding({
      chatId: 'chat-123',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp',
      model: '',
    });

    assert.ok(binding.id);
    assert.equal(binding.chatId, 'chat-123');
    assert.equal(binding.codepilotSessionId, session.id);

    const retrieved = store.getChannelBinding('chat-123');
    assert.ok(retrieved);
    assert.equal(retrieved!.id, binding.id);
  });

  test('updateChannelBinding', () => {
    const store = new JsonFileStore(config);
    const session = store.createSession('test', '', undefined, '/tmp');
    const binding = store.upsertChannelBinding({
      chatId: 'chat-update-test',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp',
      model: '',
    });

    store.updateChannelBinding(binding.id, { mode: 'plan' });
    const updated = store.getChannelBinding('chat-update-test');
    assert.equal(updated!.mode, 'plan');
  });

  test('addMessage and getMessages', () => {
    const store = new JsonFileStore(config);
    const session = store.createSession('test', '', undefined, '/tmp');

    store.addMessage(session.id, 'user', 'hello');
    store.addMessage(session.id, 'assistant', 'hi there');

    const { messages } = store.getMessages(session.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');
  });

  test('addMessage persists usage JSON when provided', () => {
    const store = new JsonFileStore(config);
    const session = store.createSession('test', '', undefined, '/tmp');

    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 20,
      cost_usd: 0.001,
    };
    store.addMessage(session.id, 'assistant', 'hi', JSON.stringify(usage));

    const { messages } = store.getMessages(session.id);
    assert.equal(messages[0].usage?.input_tokens, 100);
    assert.equal(messages[0].usage?.output_tokens, 50);
    assert.equal(messages[0].usage?.cost_usd, 0.001);
  });

  test('addMessage ignores malformed usage JSON', () => {
    const store = new JsonFileStore(config);
    const session = store.createSession('test', '', undefined, '/tmp');

    store.addMessage(session.id, 'assistant', 'hi', 'not valid json {{{');

    const { messages } = store.getMessages(session.id);
    assert.equal(messages[0].usage, undefined, 'malformed usage should not crash');
  });

  test('getUsageSummary returns null when no assistant usage', () => {
    const store = new JsonFileStore(config);
    const session = store.createSession('test', '', undefined, '/tmp');

    assert.equal(store.getUsageSummary(session.id), null, 'empty session should return null');

    store.addMessage(session.id, 'user', 'hello');
    assert.equal(store.getUsageSummary(session.id), null, 'only user msgs should not count');
  });

  test('getUsageSummary aggregates across multiple assistant messages', () => {
    const store = new JsonFileStore(config);
    const session = store.createSession('test', '', undefined, '/tmp');

    const usage1 = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80, cost_usd: 0.001 };
    const usage2 = { input_tokens: 200, output_tokens: 80, cache_creation_input_tokens: 30, cost_usd: 0.002 };
    store.addMessage(session.id, 'assistant', 'msg1', JSON.stringify(usage1));
    store.addMessage(session.id, 'assistant', 'msg2', JSON.stringify(usage2));

    const s = store.getUsageSummary(session.id);
    assert.ok(s);
    assert.equal(s.messageCount, 2);
    assert.equal(s.totalInput, 300);
    assert.equal(s.totalOutput, 130);
    assert.equal(s.totalCacheRead, 80);
    assert.equal(s.totalCacheCreation, 30);
    assert.equal(Math.abs(s.totalCostUsd - 0.003) < 0.0001, true);
  });

  test('session lock acquire/release', () => {
    const store = new JsonFileStore(config);
    const ok1 = store.acquireSessionLock('sess-1', 'lock-a', 'bridge', 60);
    assert.ok(ok1);

    // Same lock ID can re-acquire
    const ok2 = store.acquireSessionLock('sess-1', 'lock-a', 'bridge', 60);
    assert.ok(ok2);

    // Different lock ID fails
    const ok3 = store.acquireSessionLock('sess-1', 'lock-b', 'bridge', 60);
    assert.ok(!ok3);

    // After release, different lock can acquire
    store.releaseSessionLock('sess-1', 'lock-a');
    const ok4 = store.acquireSessionLock('sess-1', 'lock-b', 'bridge', 60);
    assert.ok(ok4);
  });

  test('dedup check/insert/cleanup', () => {
    const store = new JsonFileStore(config);
    assert.ok(!store.checkDedup('key-1'));
    store.insertDedup('key-1');
    assert.ok(store.checkDedup('key-1'));
    store.cleanupExpiredDedup(); // Shouldn't remove recent dedup
    assert.ok(store.checkDedup('key-1'));
  });

  test('permission links', () => {
    const store = new JsonFileStore(config);
    store.insertPermissionLink({
      permissionRequestId: 'perm-1',
      chatId: 'chat-1',
      messageId: 'msg-1',
      toolName: 'Read',
      suggestions: '',
    });

    const link = store.getPermissionLink('perm-1');
    assert.ok(link);
    assert.equal(link!.chatId, 'chat-1');
    assert.equal(link!.resolved, false);

    const claimed = store.markPermissionLinkResolved('perm-1');
    assert.ok(claimed);

    const claimedAgain = store.markPermissionLinkResolved('perm-1');
    assert.ok(!claimedAgain);

    const pending = store.listPendingPermissionLinksByChat('chat-1');
    assert.equal(pending.length, 0);
  });

  test('audit log', () => {
    const store = new JsonFileStore(config);
    store.insertAuditLog({
      chatId: 'chat-1',
      direction: 'inbound',
      messageId: 'msg-1',
      summary: 'test message',
    });
    // No crash = pass (audit log is fire-and-forget)
    assert.ok(true);
  });

  test('updateSdkSessionId propagates to bindings', () => {
    const store = new JsonFileStore(config);
    const session = store.createSession('test', '', undefined, '/tmp');
    const binding = store.upsertChannelBinding({
      chatId: 'chat-sdk-test',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp',
      model: '',
    });

    store.updateSdkSessionId(session.id, 'sdk-uuid-123');
    const updated = store.getChannelBinding('chat-sdk-test');
    assert.equal(updated!.sdkSessionId, 'sdk-uuid-123');
  });

  // Cleanup
  test('cleanup temp dir', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CTI_HOME;
  });
});

// ── Session Scanner ─────────────────────────────────────────

describe('session-scanner', async () => {
  const { scanCliSessions, formatRelativeTime } = await import('../session-scanner.js');

  test('scanCliSessions returns an array', () => {
    const sessions = scanCliSessions({ limit: 5 });
    assert.ok(Array.isArray(sessions));
    // May or may not find sessions depending on machine state
  });

  test('scanCliSessions returns sessions with expected shape', () => {
    const sessions = scanCliSessions({ limit: 3 });
    for (const s of sessions) {
      assert.ok(typeof s.sdkSessionId === 'string');
      assert.ok(typeof s.project === 'string');
      assert.ok(typeof s.cwd === 'string');
      assert.ok(typeof s.timestamp === 'number');
      assert.ok(typeof s.isOpen === 'boolean');
    }
  });

  test('formatRelativeTime works for recent times', () => {
    assert.ok(formatRelativeTime(Date.now() - 30000).includes('秒前'));
    assert.ok(formatRelativeTime(Date.now() - 300000).includes('分钟前'));
    assert.ok(formatRelativeTime(Date.now() - 7200000).includes('小时前'));
    assert.ok(formatRelativeTime(Date.now() - 172800000).includes('天前'));
  });
});

// ── Delivery (chunking logic) ───────────────────────────────

describe('delivery-chunking', async () => {
  // We can't easily import the private chunkText function, but we can test
  // the exported deliver function with a mock. Instead, let's test
  // the ChatRateLimiter indirectly by accessing it.
  // Actually, let's just verify the module loads without error.
  test('delivery module loads', async () => {
    const mod = await import('../delivery.js');
    assert.ok(typeof mod.deliver === 'function');
  });
});

// ── Claude Provider ─────────────────────────────────────────

describe('claude-provider', async () => {
  const {
    classifyAuthError,
    classifyError,
    resolveClaudeCliPath,
    preflightCheck,
    buildSubprocessEnv,
  } = await import('../claude-provider.js');

  test('classifyAuthError detects CLI auth errors', () => {
    assert.equal(classifyAuthError('not logged in'), 'cli');
    assert.equal(classifyAuthError('please run /login'), 'cli');
  });

  test('classifyAuthError detects API auth errors', () => {
    assert.equal(classifyAuthError('unauthorized'), 'api');
    assert.equal(classifyAuthError('invalid api key'), 'api');
    assert.equal(classifyAuthError('401 error'), 'api');
  });

  test('classifyAuthError returns false for normal text', () => {
    assert.equal(classifyAuthError('hello world'), false);
  });

  // B5: comprehensive error classification
  test('classifyError detects rate_limit (429, too many requests)', () => {
    assert.equal(classifyError('HTTP 429'), 'rate_limit');
    assert.equal(classifyError('rate limit exceeded'), 'rate_limit');
    assert.equal(classifyError('Too Many Requests'), 'rate_limit');
    assert.equal(classifyError('quota exceeded for today'), 'rate_limit');
  });

  test('classifyError detects network errors (ECONNREFUSED, timeout, etc.)', () => {
    assert.equal(classifyError('connect ECONNREFUSED 127.0.0.1:443'), 'network');
    assert.equal(classifyError('connect ETIMEDOUT'), 'network');
    assert.equal(classifyError('getaddrinfo ENOTFOUND api.example.com'), 'network');
    assert.equal(classifyError('socket hang up'), 'network');
    assert.equal(classifyError('request timeout'), 'network');
    assert.equal(classifyError('fetch failed'), 'network');
  });

  test('classifyError detects model_not_found', () => {
    assert.equal(classifyError('model claude-x-99 not found'), 'model_not_found');
    assert.equal(classifyError('unknown model: glm-fake'), 'model_not_found');
    assert.equal(classifyError('404 model not found'), 'model_not_found');
  });

  test('classifyError detects context_too_long', () => {
    assert.equal(classifyError('context length exceeded'), 'context_too_long');
    assert.equal(classifyError('too many tokens in conversation'), 'context_too_long');
    assert.equal(classifyError('maximum context window reached'), 'context_too_long');
    assert.equal(classifyError('HTTP 413 payload too large'), 'context_too_long');
  });

  test('classifyError detects permission_denied (403, forbidden)', () => {
    assert.equal(classifyError('HTTP 403'), 'permission_denied');
    assert.equal(classifyError('permission denied for resource'), 'permission_denied');
    assert.equal(classifyError('forbidden'), 'permission_denied');
  });

  test('classifyError auth still works in new API', () => {
    assert.equal(classifyError('not logged in'), 'auth_cli');
    assert.equal(classifyError('invalid api key'), 'auth_api');
  });

  test('classifyError returns unknown for unrecognized errors', () => {
    assert.equal(classifyError('some random error'), 'unknown');
    assert.equal(classifyError('null'), 'unknown');
    assert.equal(classifyError(''), 'unknown');
  });

  test('classifyError priority: auth before rate_limit (401 vs 429)', () => {
    // Both patterns might match; auth is checked first so 401 wins
    assert.equal(classifyError('401 unauthorized'), 'auth_api');
  });

  test('buildSubprocessEnv strips CLAUDECODE', () => {
    process.env.CLAUDECODE = 'test';
    const env = buildSubprocessEnv();
    assert.ok(!('CLAUDECODE' in env));
    delete process.env.CLAUDECODE;
  });

  test('resolveClaudeCliPath finds claude CLI', () => {
    const path = resolveClaudeCliPath();
    // Should find it on this machine since claude is installed
    assert.ok(path, 'Should find claude CLI path');
    console.log(`  Found claude CLI at: ${path}`);
  });

  test('preflightCheck passes on found CLI', () => {
    const cliPath = resolveClaudeCliPath();
    if (!cliPath) {
      console.log('  Skipping: claude CLI not found');
      return;
    }
    const result = preflightCheck(cliPath);
    assert.ok(result.ok, `Preflight should pass: ${result.error}`);
    console.log(`  Claude CLI version: ${result.version}`);
  });
});

// ── Claude Memory (bridge-managed section in ~/.claude/CLAUDE.md) ──

describe('claude-memory', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const {
    ClaudeMemory,
    BRIDGE_SECTION_START,
    BRIDGE_SECTION_END,
    parseEntries,
    upsertEntry,
    rebuildSection,
  } = await import('../claude-memory.js');

  function tmpFile(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-test-')), 'CLAUDE.md');
  }

  test('readEntries returns empty when file does not exist', () => {
    const mem = new ClaudeMemory(tmpFile());
    assert.equal(mem.readEntries().length, 0);
    assert.equal(mem.readAll(), '');
    assert.equal(mem.exists(), false);
  });

  test('setEntry creates bridge section when file is empty', () => {
    const path_ = tmpFile();
    const mem = new ClaudeMemory(path_);
    mem.setEntry('language', '中文回复');
    const content = fs.readFileSync(path_, 'utf-8');
    assert.ok(content.includes(BRIDGE_SECTION_START), 'should have start marker');
    assert.ok(content.includes(BRIDGE_SECTION_END), 'should have end marker');
    assert.ok(content.includes('## language'), 'should have key heading');
    assert.ok(content.includes('中文回复'), 'should have value');
    assert.equal(mem.readEntries().length, 1);
    assert.equal(mem.readEntries()[0].key, 'language');
    assert.equal(mem.readEntries()[0].value, '中文回复');
  });

  test('setEntry upserts existing key (replace value)', () => {
    const path_ = tmpFile();
    const mem = new ClaudeMemory(path_);
    mem.setEntry('language', '中文');
    mem.setEntry('language', '中文 + 简短');
    const entries = mem.readEntries();
    assert.equal(entries.length, 1, 'still 1 entry, not duplicated');
    assert.equal(entries[0].value, '中文 + 简短');
  });

  test('setEntry adds multiple keys', () => {
    const path_ = tmpFile();
    const mem = new ClaudeMemory(path_);
    mem.setEntry('language', '中文');
    mem.setEntry('style', '简短直接');
    mem.setEntry('cwd_default', '/home/son_goku');
    const entries = mem.readEntries();
    assert.equal(entries.length, 3);
    const keys = entries.map(e => e.key).sort();
    assert.deepEqual(keys, ['cwd_default', 'language', 'style']);
  });

  test('removeEntry returns false for missing key', () => {
    const mem = new ClaudeMemory(tmpFile());
    assert.equal(mem.removeEntry('nope'), false);
  });

  test('removeEntry deletes and removes section when empty', () => {
    const path_ = tmpFile();
    const mem = new ClaudeMemory(path_);
    mem.setEntry('temp', 'value');
    assert.equal(mem.removeEntry('temp'), true);
    assert.equal(mem.readEntries().length, 0);
    const content = fs.readFileSync(path_, 'utf-8');
    assert.ok(!content.includes(BRIDGE_SECTION_START), 'section should be gone');
  });

  test('removeEntry deletes one of multiple, keeps section', () => {
    const path_ = tmpFile();
    const mem = new ClaudeMemory(path_);
    mem.setEntry('a', '1');
    mem.setEntry('b', '2');
    mem.setEntry('c', '3');
    assert.equal(mem.removeEntry('b'), true);
    const entries = mem.readEntries();
    assert.equal(entries.length, 2);
    const keys = entries.map(e => e.key).sort();
    assert.deepEqual(keys, ['a', 'c']);
  });

  // Critical: preserve user/CLI content outside the bridge section
  test('setEntry preserves content outside bridge section byte-for-byte', () => {
    const userContent = [
      '# My Personal Notes',
      '',
      'This is content I wrote manually.',
      '',
      '```bash',
      'echo hello',
      '```',
      '',
    ].join('\n');
    const path_ = tmpFile();
    fs.writeFileSync(path_, userContent);
    const mem = new ClaudeMemory(path_);
    mem.setEntry('language', '中文');
    const after = fs.readFileSync(path_, 'utf-8');
    // User content (before bridge section) must be byte-identical
    assert.ok(after.startsWith(userContent), 'user content must be preserved at the top');
    // Bridge section appears at the end
    assert.ok(after.includes(BRIDGE_SECTION_START));
    assert.ok(after.includes('中文'));
  });

  test('removeEntry preserves content outside bridge section', () => {
    const userContent = '# Top\n\nUser notes here.\n';
    const path_ = tmpFile();
    fs.writeFileSync(path_, userContent);
    const mem = new ClaudeMemory(path_);
    mem.setEntry('key1', 'val1');
    // Now remove
    mem.removeEntry('key1');
    const after = fs.readFileSync(path_, 'utf-8');
    // User content preserved (allow trailing whitespace normalization)
    assert.ok(after.includes('# Top'));
    assert.ok(after.includes('User notes here.'));
    assert.ok(!after.includes(BRIDGE_SECTION_START), 'empty section should be removed');
  });

  // Parser unit tests (independent of file I/O)
  test('parseEntries handles multiline values', () => {
    const section = `
## key1
value line 1
value line 2

## key2
single line
`;
    const entries = parseEntries(section);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].key, 'key1');
    assert.equal(entries[0].value, 'value line 1\nvalue line 2');
    assert.equal(entries[1].key, 'key2');
    assert.equal(entries[1].value, 'single line');
  });

  test('parseEntries skips entries with empty values', () => {
    const section = `
## key1
## key2
real value
`;
    const entries = parseEntries(section);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, 'key2');
  });

  test('upsertEntry pure function (no file I/O)', () => {
    // No existing section
    const r1 = upsertEntry('', 'k', 'v');
    assert.ok(r1.includes(BRIDGE_SECTION_START));
    assert.ok(r1.includes('## k'));
    assert.ok(r1.includes('v'));

    // Section exists, new key
    const r2 = upsertEntry(`prefix\n${BRIDGE_SECTION_START}\n## old\nval\n${BRIDGE_SECTION_END}\nsuffix`, 'new', 'val2');
    assert.ok(r2.startsWith('prefix'), 'prefix preserved');
    assert.ok(r2.includes('## old'), 'old key preserved');
    assert.ok(r2.includes('## new'), 'new key added');
    assert.ok(r2.endsWith('suffix'), 'suffix preserved');

    // Section exists, update key
    const r3 = upsertEntry(`x${BRIDGE_SECTION_START}\n## k\nold${BRIDGE_SECTION_END}y`, 'k', 'new');
    assert.ok(r3.includes('## k\nnew'), 'value updated');
    assert.ok(!r3.includes('old'), 'old value gone');
    assert.ok(r3.startsWith('x'), 'prefix preserved');
    assert.ok(r3.endsWith('y'), 'suffix preserved');
  });

  test('rebuildSection empty entries removes section', () => {
    const content = `before\n${BRIDGE_SECTION_START}\n## k\nv\n${BRIDGE_SECTION_END}\nafter`;
    const r = rebuildSection(content, []);
    assert.ok(!r.includes(BRIDGE_SECTION_START));
    assert.ok(r.includes('before'));
    assert.ok(r.includes('after'));
  });
});

// ── Permissions ──────────────────────────────────────────────

describe('permissions', async () => {
  const { PendingPermissions } = await import('../permissions.js');

  test('waitFor resolves when resolved', async () => {
    const perms = new PendingPermissions();
    const promise = perms.waitFor('tool-1');
    const resolved = perms.resolve('tool-1', { behavior: 'allow' });
    assert.ok(resolved);
    const result = await promise;
    assert.equal(result.behavior, 'allow');
  });

  test('waitFor resolves deny', async () => {
    const perms = new PendingPermissions();
    const promise = perms.waitFor('tool-2');
    perms.resolve('tool-2', { behavior: 'deny', message: 'nope' });
    const result = await promise;
    assert.equal(result.behavior, 'deny');
    assert.equal(result.message, 'nope');
  });

  test('resolve returns false for unknown ID', () => {
    const perms = new PendingPermissions();
    assert.ok(!perms.resolve('nonexistent', { behavior: 'allow' }));
  });

  test('denyAll resolves all pending', async () => {
    const perms = new PendingPermissions();
    const p1 = perms.waitFor('t1');
    const p2 = perms.waitFor('t2');
    assert.equal(perms.size, 2);
    perms.denyAll();
    assert.equal(perms.size, 0);
    const r1 = await p1;
    const r2 = await p2;
    assert.equal(r1.behavior, 'deny');
    assert.equal(r2.behavior, 'deny');
  });
});

// ── Bridge: buildTree (B7 slash command) ────────────────────

describe('bridge-buildTree', async () => {
  const { buildTree } = await import('../bridge.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  let tmpDir: string;

  test('buildTree returns empty string for maxDepth=0', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b7-tree-'));
    assert.equal(buildTree(tmpDir, tmpDir, 0), '');
  });

  test('buildTree lists files and dirs, dirs get / suffix', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b7-tree-'));
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'hi');
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), '');

    const out = buildTree(tmpDir, tmpDir, 2);
    assert.ok(out.includes('README.md'));
    assert.ok(out.includes('src/'), 'dir should have / suffix');
    assert.ok(out.includes('index.ts'), 'nested file should appear');
  });

  test('buildTree ignores node_modules, .git, dist, build', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b7-tree-'));
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), '');
    fs.mkdirSync(path.join(tmpDir, 'node_modules'));
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'junk.ts'), '');
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), '');
    fs.mkdirSync(path.join(tmpDir, 'dist'));
    fs.mkdirSync(path.join(tmpDir, 'build'));

    const out = buildTree(tmpDir, tmpDir, 2);
    assert.ok(out.includes('app.ts'));
    assert.ok(!out.includes('node_modules'), 'should ignore node_modules');
    assert.ok(!out.includes('.git'), 'should ignore .git');
    assert.ok(!out.includes('dist'), 'should ignore dist');
    assert.ok(!out.includes('build'), 'should ignore build');
  });

  test('buildTree respects depth limit', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b7-tree-'));
    fs.mkdirSync(path.join(tmpDir, 'a'));
    fs.mkdirSync(path.join(tmpDir, 'a', 'b'));
    fs.mkdirSync(path.join(tmpDir, 'a', 'b', 'c'));
    fs.writeFileSync(path.join(tmpDir, 'a', 'b', 'c', 'deep.ts'), '');

    // depth=1: see 'a/' only
    const depth1 = buildTree(tmpDir, tmpDir, 1);
    assert.ok(depth1.includes('a/'));
    assert.ok(!depth1.includes('deep.ts'), 'depth=1 should not see 3 levels deep');

    // depth=3: see 'c/' but not deep.ts (depth=4 needed)
    const depth3 = buildTree(tmpDir, tmpDir, 3);
    assert.ok(depth3.includes('a/'));
    assert.ok(depth3.includes('b/'));
    assert.ok(depth3.includes('c/'));
    assert.ok(!depth3.includes('deep.ts'));

    // depth=4: see deep.ts
    const depth4 = buildTree(tmpDir, tmpDir, 4);
    assert.ok(depth4.includes('deep.ts'));
  });

  test('buildTree truncates at 30 entries per dir with hint', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b7-tree-'));
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i.toString().padStart(2, '0')}.ts`), '');
    }

    const out = buildTree(tmpDir, tmpDir, 1);
    assert.ok(out.includes('...'), 'should show truncation hint');
    assert.ok(out.includes('more'), 'hint should mention remaining count');
  });

  test('buildTree handles non-existent path gracefully', () => {
    const out = buildTree('/nonexistent/path/xyz', '/nonexistent/path/xyz', 2);
    assert.ok(out.includes('无法读取') || out.includes('ENOENT') || out.length > 0);
  });
});
