import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { closeDatabase, initializeDatabase, type Db } from '../src/db/index.js';
import { SESSION_COOKIE } from '../src/plugins/auth.js';
import { AiConfigService } from '../src/services/ai-config-service.js';
import { AuthService } from '../src/services/auth-service.js';
import type { AssistantGenerationSnapshot } from '../src/services/assistant-stream-types.js';

const USERNAME = 'quiz';
const PASSWORD = 'correct horse battery staple';
const CSRF = { 'x-requested-with': 'fetch' };
const KEY = 'ab'.repeat(32);
/** Stable hash-derived id of the ready `category-merge` plan that `seedOrganizationMerges`
 * produces (`actionId()` truncates sha256({kind,sourceId,targetId}) to 24 hex chars). The
 * nested provider call in `organization.apply.prepare` is gated on transaction text, which
 * no live row supplies, so the test must select the action explicitly to reach the nested
 * request; an empty `actionIds` list falls back to every ready action and would never call
 * the provider here. */
const ORG_READY_ACTION_ID = '22930e7f86f4c13aa9c19ea8';
const NOW = Date.UTC(2026, 8, 22, 12);

let db: Db;
let app: FastifyInstance;
let cookie: string;
let testDataDir: string;
/** Injectable wall clock: the runner's deadline arithmetic uses `this.now`, so tests can
 * advance it across a nested provider request without waiting 180 s of real time. */
let currentNow: number;

/** One provider turn the mock is expected to serve. */
type Turn =
  | { readonly kind: 'envelope'; readonly value: unknown }
  | { readonly kind: 'gated-envelope'; readonly value: unknown; readonly gate: Promise<void> }
  | {
      readonly kind: 'sse';
      readonly chunks: readonly string[];
      /** Frames written before `gate` resolves, so a test can observe partial progress. */
      readonly head?: readonly string[];
      readonly contentType?: string;
      /** Resolved before the remaining chunks are written. */
      readonly gate?: Promise<void>;
    }
  | { readonly kind: 'status'; readonly status: number };

let turns: Turn[] = [];
let providerBodies: unknown[] = [];
let spendingGate: Promise<void> | undefined;
let spendingSignal: AbortSignal | undefined;

function envelope(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ message, toolCall: null, clarification: null, ...extra });
}

function deltaFrame(content: string, finish: string | null = null): string {
  const choice: Record<string, unknown> = { index: 0, delta: { content } };
  if (finish !== null) choice['finish_reason'] = finish;
  return `data: ${JSON.stringify({ choices: [choice] })}\n\n`;
}

/** Envelope delivered as a well-formed Chat-completions SSE reply. */
function sseEnvelope(message: string, extra: Record<string, unknown> = {}): string[] {
  return [deltaFrame(envelope(message, extra)), deltaFrame('', 'stop'), 'data: [DONE]\n\n'];
}

function bufferedEnvelope(value: unknown): Turn {
  return { kind: 'envelope', value };
}

function streamingFetch(url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  void url;
  if (typeof init?.body === 'string') providerBodies.push(JSON.parse(init.body) as unknown);
  if (spendingGate && typeof init?.body === 'string' && init.body.includes('本批不可信账单数据和服务端分类事实')) {
    spendingSignal = init.signal ?? undefined;
    const gate = spendingGate;
    return (async () => {
      await gate;
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        reclassifications: [], tagSuggestions: [], noteSuggestions: [], newCategories: [],
      }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    })();
  }
  const turn = turns.shift();
  if (turn === undefined) throw new Error('no mocked provider turn left');
  if (turn.kind === 'status') {
    return Promise.resolve(new Response('{}', { status: turn.status }));
  }
  if (turn.kind === 'envelope') {
    return Promise.resolve(
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(turn.value) } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }
  if (turn.kind === 'gated-envelope') {
    // Legacy buffered turn held open so the v1/lock ordering is observable.
    return (async () => {
      await turn.gate;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(turn.value) } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    })();
  }
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of turn.head ?? []) controller.enqueue(encoder.encode(chunk));
      if (turn.gate !== undefined) await turn.gate;
      for (const chunk of turn.chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return Promise.resolve(
    new Response(body, {
      status: 200,
      headers: { 'content-type': turn.contentType ?? 'text/event-stream' },
    }),
  );
}

function authHeaders(): Record<string, string> {
  return { ...CSRF, Cookie: `${SESSION_COOKIE}=${cookie}` };
}

async function inject(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
  includeAuth = true,
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  return app.inject({
    method,
    url,
    headers: includeAuth ? authHeaders() : CSRF,
    ...(payload === undefined ? {} : { payload }),
  });
}

async function waitForTerminal(conversationId: string, generationId: string): Promise<AssistantGenerationSnapshot> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await inject('GET', `/api/v1/assistant/conversations/${conversationId}/generations/${generationId}`);
    const snapshot = (response.json() as { generation: AssistantGenerationSnapshot }).generation;
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('generation did not reach a terminal status');
}

async function waitForStatus(
  conversationId: string,
  generationId: string,
  status: string,
): Promise<AssistantGenerationSnapshot> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await inject('GET', `/api/v1/assistant/conversations/${conversationId}/generations/${generationId}`);
    const snapshot = (response.json() as { generation: AssistantGenerationSnapshot }).generation;
    if (snapshot.status === status) return snapshot;
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.status)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`generation never reached ${status}`);
}

async function waitFor<T>(read: () => Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was never satisfied');
}

/** Extracts the single clarification the assistant asked on a completed turn. */
function clarificationOf(snapshot: AssistantGenerationSnapshot): {
  id: string;
  options: { id: string; label: string }[];
} {
  const message = snapshot.messages[0] as {
    content: { clarification: { id: string; options: { id: string; label: string }[] } };
  };
  return message.content.clarification;
}

/** The persisted `answered_*` columns of one generation, i.e. whether *its own* question was answered. */
function answerState(generationId: string): { answeredOptionId: string | null; answeredAt: number | null } {
  const row = db
    .prepare('SELECT answered_option_id, answered_at FROM assistant_generations WHERE id = ?')
    .get(generationId) as { answered_option_id: string | null; answered_at: number | null } | undefined;
  if (row === undefined) throw new Error(`generation ${generationId} is missing`);
  return { answeredOptionId: row.answered_option_id, answeredAt: row.answered_at };
}

/** Stored client input, used to prove provenance survives without the source answer columns. */
function storedInput(generationId: string): Record<string, unknown> {
  const row = db.prepare('SELECT input_json FROM assistant_generations WHERE id = ?').get(generationId) as
    | { input_json: string }
    | undefined;
  if (row === undefined) throw new Error(`generation ${generationId} is missing`);
  return JSON.parse(row.input_json) as Record<string, unknown>;
}

async function createConversation(): Promise<string> {
  const response = await inject('POST', '/api/v1/assistant/conversations', { title: 'stream test' });
  return (response.json() as { id: string }).id;
}

async function createGeneration(
  conversationId: string,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; created?: boolean; generation?: AssistantGenerationSnapshot; error?: { code: string } }> {
  const response = await inject('POST', `/api/v1/assistant/conversations/${conversationId}/generations`, body);
  return { statusCode: response.statusCode, ...(response.json() as object) } as never;
}

beforeEach(async () => {
  testDataDir = mkdtempSync(join(tmpdir(), 'assistant-stream-routes-'));
  currentNow = NOW;
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initializeDatabase(db, null);
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    JIZHANG_USERNAME: USERNAME,
    JIZHANG_PASSWORD_HASH: 'unused',
    JIZHANG_AI_ENCRYPTION_KEY: KEY,
    DATA_DIR: testDataDir,
  });
  const auth = new AuthService(db, { sessionTtlDays: config.sessionTtlDays, now: () => currentNow });
  await auth.setPassword(USERNAME, PASSWORD);
  new AiConfigService(db, { aiEncryptionKey: KEY, production: false, now: () => currentNow }).save({
    enabled: true,
    mode: 'chat-completions',
    name: 'stream test provider',
    url: 'https://provider.example.test/v1/chat/completions',
    method: 'POST',
    model: 'test-model',
    timeoutMs: 5_000,
    headers: {},
    auth: { kind: 'bearer' },
    bodyTemplate: null,
    responsePath: 'choices[0].message.content',
    secret: 'test-only-provider-secret',
  });
  turns = [];
  providerBodies = [];
  spendingGate = undefined;
  spendingSignal = undefined;
  app = buildApp({
    config,
    db,
    authService: auth,
    secureCookies: false,
    now: () => currentNow,
    fetchImpl: streamingFetch,
    generationDelayMs: 0,
    generationStepDelayMs: 0,
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: CSRF,
    payload: { username: USERNAME, password: PASSWORD },
  });
  const setCookie = login.headers['set-cookie'];
  cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]?.split('=')[1] ?? '';
});

afterEach(async () => {
  await app.close();
  closeDatabase(db);
  rmSync(testDataDir, { recursive: true, force: true });
});

describe('generation creation contract', () => {
  it('requires authentication and the CSRF header', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/v1/assistant/conversations/whatever/generations',
      headers: CSRF,
    });
    expect(anonymous.statusCode).toBe(401);

    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/assistant/conversations/whatever/generations',
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}` },
      payload: { version: 1, clientRequestId: 'req_1', input: { type: 'text', text: 'hi' } },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('rejects unknown fields, wrong version and bad input shapes', async () => {
    const conversationId = await createConversation();
    const unknownField = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_unknown',
      input: { type: 'text', text: 'hello' },
      extra: true,
    });
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.error?.code).toBe('ASSISTANT_GENERATION_INVALID');

    const badVersion = await createGeneration(conversationId, {
      version: 2,
      clientRequestId: 'req_version',
      input: { type: 'text', text: 'hello' },
    });
    expect(badVersion.statusCode).toBe(400);

    const badInput = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_input',
      input: { type: 'text', text: '   ' },
    });
    expect(badInput.statusCode).toBe(400);
    expect(turns.length).toBe(0);
  });

  it('replays an identical payload with 200 and rejects a conflicting one with 409', async () => {
    const conversationId = await createConversation();
    turns.push(bufferedEnvelope({ message: 'ok', toolCall: null, clarification: null }));
    const body = { version: 1, clientRequestId: 'req_replay', input: { type: 'text', text: '你好' } };
    const first = await createGeneration(conversationId, body);
    expect(first.statusCode).toBe(202);
    expect(first.created).toBe(true);
    await waitForTerminal(conversationId, first.generation!.id);

    const replay = await createGeneration(conversationId, body);
    expect(replay.statusCode).toBe(200);
    expect(replay.created).toBe(false);
    expect(replay.generation?.id).toBe(first.generation?.id);

    const conflict = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_replay',
      input: { type: 'text', text: '不同内容' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.error?.code).toBe('ASSISTANT_REQUEST_CONFLICT');
    // A conflict and a replay must not have produced extra provider work.
    expect(providerBodies.length).toBe(1);
  });

  it('rejects a second generation while one is live, from both new and legacy entry points', async () => {
    const conversationId = await createConversation();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    turns.push({ kind: 'sse', chunks: sseEnvelope('仍然在生成'), gate });
    const first = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_active',
      input: { type: 'text', text: '统计一下' },
    });
    expect(first.statusCode).toBe(202);
    await waitForStatus(conversationId, first.generation!.id, 'running');

    const second = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_active_2',
      input: { type: 'text', text: '再来一次' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.error?.code).toBe('ASSISTANT_GENERATION_ACTIVE');

    const legacy = await inject('POST', `/api/v1/assistant/conversations/${conversationId}/messages`, {
      text: '旧入口',
      clientRequestId: 'legacy_req_1',
    });
    expect(legacy.statusCode).toBe(409);
    expect((legacy.json() as { error: { code: string } }).error.code).toBe('ASSISTANT_GENERATION_ACTIVE');

    release();
    const finished = await waitForTerminal(conversationId, first.generation!.id);
    expect(finished.status).toBe('completed');
    // Neither rejected attempt produced its own generation row.
    const rows = db
      .prepare('SELECT COUNT(*) AS c FROM assistant_generations WHERE conversation_id = ?')
      .get(conversationId) as { c: number };
    expect(rows.c).toBe(1);
  });
});

describe('streamed generation lifecycle', () => {
  it('delivers ordered events, a stable message id and the captured server today', async () => {
    const conversationId = await createConversation();
    turns.push({ kind: 'sse', chunks: sseEnvelope('今天几号？今天是 2026-09-22。') });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_stream',
      input: { type: 'text', text: '今天几号' },
    });
    expect(created.statusCode).toBe(202);
    expect(created.generation?.delivery).toBe('stream');

    const finished = await waitForTerminal(conversationId, created.generation!.id);
    expect(finished.status).toBe('completed');
    expect(finished.outcome).toBe('answer');
    expect(finished.messageIds.length).toBe(1);
    expect((finished.messages[0] as { content: { generationId: string } }).content.generationId).toBe(created.generation!.id);

    const events = await inject(
      'GET',
      `/api/v1/assistant/conversations/${conversationId}/generations/${created.generation!.id}/events?afterSeq=0`,
    );
    const raw = events.body;
    expect(raw).toContain('id: 1');
    expect(raw).toContain('event: state');
    expect(raw).toContain('event: text-delta');
    expect(raw).toContain('event: message');
    expect(raw).toContain('event: terminal');
    // Replay is not a new model call.
    expect(providerBodies.length).toBe(1);
    // The captured server date is in the prompt, not the device's.
    const body = providerBodies[0] as { messages: { content: string }[] };
    const prompt = body.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('2026-09-22');
    expect(prompt).toContain('serverToday');
  });

  it('rejects a replay request beyond lastSeq before any model work', async () => {
    const conversationId = await createConversation();
    turns.push({ kind: 'sse', chunks: sseEnvelope('ok') });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_replay_gap',
      input: { type: 'text', text: '你好' },
    });
    await waitForTerminal(conversationId, created.generation!.id);

    const gap = await inject(
      'GET',
      `/api/v1/assistant/conversations/${conversationId}/generations/${created.generation!.id}/events?afterSeq=999`,
    );
    expect(gap.statusCode).toBe(409);
    expect((gap.json() as { error: { code: string } }).error.code).toBe('ASSISTANT_REPLAY_UNAVAILABLE');

    const negative = await inject(
      'GET',
      `/api/v1/assistant/conversations/${conversationId}/generations/${created.generation!.id}/events?afterSeq=-1`,
    );
    expect(negative.statusCode).toBe(400);
    expect(providerBodies.length).toBe(1);
  });

  it('exposes the latest generation without starting model work', async () => {
    const conversationId = await createConversation();
    turns.push({ kind: 'sse', chunks: sseEnvelope('hello') });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_latest',
      input: { type: 'text', text: 'hi' },
    });
    await waitForTerminal(conversationId, created.generation!.id);

    const latest = await inject('GET', `/api/v1/assistant/conversations/${conversationId}/generations?limit=1`);
    expect(latest.statusCode).toBe(200);
    const items = (latest.json() as { items: AssistantGenerationSnapshot[] }).items;
    expect(items.length).toBe(1);
    expect(items[0]!.id).toBe(created.generation!.id);
    expect(providerBodies.length).toBe(1);

    const badLimit = await inject('GET', `/api/v1/assistant/conversations/${conversationId}/generations?limit=5`);
    expect(badLimit.statusCode).toBe(400);
  });

  it('fails explicitly on a malformed stream instead of emitting a fake reply', async () => {
    const conversationId = await createConversation();
    turns.push({
      kind: 'sse',
      chunks: [deltaFrame('{"message":"truncated'), deltaFrame('', 'stop'), 'data: [DONE]\n\n'],
    });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_bad_stream',
      input: { type: 'text', text: 'hi' },
    });
    const finished = await waitForTerminal(conversationId, created.generation!.id);
    expect(finished.status).toBe('failed');
    expect(finished.outcome).toBeNull();
    expect(finished.messages.length).toBe(0);
    expect(finished.error?.code).toBe('ASSISTANT_STREAM_BOUNDS');
  });

  it('fails when the provider answers with a non-stream content type', async () => {
    const conversationId = await createConversation();
    turns.push({ kind: 'sse', chunks: sseEnvelope('ignored'), contentType: 'application/json' });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_ct',
      input: { type: 'text', text: 'hi' },
    });
    const finished = await waitForTerminal(conversationId, created.generation!.id);
    expect(finished.status).toBe('failed');
  });

  it('keeps responses/custom modes explicitly buffered', async () => {
    const conversationId = await createConversation();
    new AiConfigService(db, { aiEncryptionKey: KEY, production: false, now: () => currentNow }).save({
      enabled: true,
      mode: 'responses',
      name: 'buffered provider',
      url: 'https://provider.example.test/v1/responses',
      method: 'POST',
      model: 'test-model',
      timeoutMs: 5_000,
      headers: {},
      auth: { kind: 'bearer' },
      bodyTemplate: null,
      responsePath: 'choices[0].message.content',
      secret: 'test-only-provider-secret',
    });
    turns.push(bufferedEnvelope({ message: '完整回复模式', toolCall: null, clarification: null }));
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_buffered',
      input: { type: 'text', text: 'hi' },
    });
    expect(created.generation?.delivery).toBe('buffered');
    const finished = await waitForTerminal(conversationId, created.generation!.id);
    expect(finished.status).toBe('completed');
    expect(finished.messages.length).toBe(1);
  });

  it('cancels explicitly and is idempotent, without touching the ledger', async () => {
    const conversationId = await createConversation();
    const ledgerBefore = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A gated turn keeps the generation live until Stop arrives, and `head` has already
    // delivered one partial delta the snapshot must expose.
    turns.push({
      kind: 'sse',
      head: [deltaFrame('{"message":"半')],
      chunks: sseEnvelope('半途而废'),
      gate,
    });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_cancel',
      input: { type: 'text', text: '统计' },
    });
    await waitForStatus(conversationId, created.generation!.id, 'running');

    // The provisional text is visible before the upstream turn completes...
    const partial = await waitFor(
      async () => {
        const response = await inject('GET', `/api/v1/assistant/conversations/${conversationId}/generations/${created.generation!.id}`);
        const candidate = (response.json() as { generation: AssistantGenerationSnapshot }).generation.partialMessages[0];
        return candidate !== undefined && candidate.text.length > 0 ? candidate : null;
      },
    );
    expect(partial.text.length).toBeGreaterThan(0);
    expect(partial.validated).toBe(false);

    const cancelled = await inject(
      'POST',
      `/api/v1/assistant/conversations/${conversationId}/generations/${created.generation!.id}/cancel`,
    );
    expect(cancelled.statusCode).toBe(200);
    const snapshot = (cancelled.json() as { generation: AssistantGenerationSnapshot }).generation;
    expect(snapshot.status).toBe('cancelled');
    expect(snapshot.outcome).toBeNull();

    const again = await inject(
      'POST',
      `/api/v1/assistant/conversations/${conversationId}/generations/${created.generation!.id}/cancel`,
    );
    expect(again.statusCode).toBe(200);
    expect((again.json() as { generation: AssistantGenerationSnapshot }).generation.status).toBe('cancelled');
    release();
    const ledgerAfter = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
    expect(ledgerAfter).toBe(ledgerBefore);
    // A cancelled generation never grows a result message.
    expect((await waitForTerminal(conversationId, created.generation!.id)).messages.length).toBe(0);
  });
});

describe('clarification choices', () => {
  async function awaitChoice(): Promise<{ conversationId: string; generationId: string; questionId: string; options: { id: string; label: string }[] }> {
    const conversationId = await createConversation();
    turns.push({
      kind: 'sse',
      chunks: sseEnvelope('请选择付款账户', {
        clarification: { question: '使用哪个账户？', options: ['微信', '银行卡'] },
      }),
    });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: `req_choice_${Math.random().toString(36).slice(2)}`,
      input: { type: 'text', text: '午饭用哪个账户' },
    });
    const finished = await waitForTerminal(conversationId, created.generation!.id);
    expect(finished.status).toBe('completed');
    expect(finished.outcome).toBe('awaiting-choice');
    const message = finished.messages[0] as {
      content: { clarification: { id: string; selection: string; options: { id: string; label: string }[]; allowFreeText: boolean } };
    };
    expect(message.content.clarification.selection).toBe('single');
    expect(message.content.clarification.allowFreeText).toBe(true);
    expect(message.content.clarification.options.length).toBe(2);
    return {
      conversationId,
      generationId: created.generation!.id,
      questionId: message.content.clarification.id,
      options: message.content.clarification.options,
    };
  }

  it('accepts a single-select answer, consumes the question and continues the conversation', async () => {
    const choice = await awaitChoice();
    const option = choice.options[0]!;
    turns.push({ kind: 'sse', chunks: sseEnvelope('好的，已记录为微信。') });
    const next = await createGeneration(choice.conversationId, {
      version: 1,
      clientRequestId: 'req_choice_answer',
      input: {
        type: 'choice',
        sourceGenerationId: choice.generationId,
        questionId: choice.questionId,
        optionId: option.id,
      },
    });
    expect(next.statusCode).toBe(202);
    const finished = await waitForTerminal(choice.conversationId, next.generation!.id);
    expect(finished.status).toBe('completed');
    const userMessage = finished.userMessage as { content: { text: string } };
    expect(userMessage.content.text).toBe(option.label);

    // Replaying the same question is now stale, even with a fresh request id.
    const stale = await createGeneration(choice.conversationId, {
      version: 1,
      clientRequestId: 'req_choice_stale',
      input: {
        type: 'choice',
        sourceGenerationId: choice.generationId,
        questionId: choice.questionId,
        optionId: choice.options[1]!.id,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.error?.code).toBe('ASSISTANT_CHOICE_STALE');
  });

  it('rejects a forged option id and a wrong question id', async () => {
    const choice = await awaitChoice();
    const forged = await createGeneration(choice.conversationId, {
      version: 1,
      clientRequestId: 'req_forged',
      input: {
        type: 'choice',
        sourceGenerationId: choice.generationId,
        questionId: choice.questionId,
        optionId: 'forged-option',
      },
    });
    expect(forged.statusCode).toBe(409);
    expect(forged.error?.code).toBe('ASSISTANT_CHOICE_STALE');

    const wrongQuestion = await createGeneration(choice.conversationId, {
      version: 1,
      clientRequestId: 'req_wrong_question',
      input: {
        type: 'choice',
        sourceGenerationId: choice.generationId,
        questionId: 'not-the-question',
        optionId: choice.options[0]!.id,
      },
    });
    expect(wrongQuestion.statusCode).toBe(409);
  });

  it('accepts a free-text answer and supersedes the question', async () => {
    const choice = await awaitChoice();
    turns.push({ kind: 'sse', chunks: sseEnvelope('收到你的补充。') });
    const next = await createGeneration(choice.conversationId, {
      version: 1,
      clientRequestId: 'req_choice_text',
      input: {
        type: 'choice-text',
        sourceGenerationId: choice.generationId,
        questionId: choice.questionId,
        text: '用现金吧',
      },
    });
    expect(next.statusCode).toBe(202);
    const finished = await waitForTerminal(choice.conversationId, next.generation!.id);
    expect((finished.userMessage as { content: { text: string } }).content.text).toBe('用现金吧');
  });

  it('rejects a choice from another conversation', async () => {
    const choice = await awaitChoice();
    const other = await createConversation();
    const stolen = await createGeneration(other, {
      version: 1,
      clientRequestId: 'req_cross_conversation',
      input: {
        type: 'choice',
        sourceGenerationId: choice.generationId,
        questionId: choice.questionId,
        optionId: choice.options[0]!.id,
      },
    });
    expect(stolen.statusCode).toBe(409);
    expect(stolen.error?.code).toBe('ASSISTANT_CHOICE_STALE');
  });

  it('supersedes a live question when the user sends ordinary text instead', async () => {
    const choice = await awaitChoice();
    turns.push({ kind: 'sse', chunks: sseEnvelope('好，按你说的来。') });
    const superseded = await createGeneration(choice.conversationId, {
      version: 1,
      clientRequestId: 'req_supersede_text',
      input: { type: 'text', text: '算了，用现金' },
    });
    expect(superseded.statusCode).toBe(202);
    await waitForTerminal(choice.conversationId, superseded.generation!.id);

    const lateClick = await createGeneration(choice.conversationId, {
      version: 1,
      clientRequestId: 'req_after_supersede',
      input: {
        type: 'choice',
        sourceGenerationId: choice.generationId,
        questionId: choice.questionId,
        optionId: choice.options[1]!.id,
      },
    });
    expect(lateClick.statusCode).toBe(409);
    expect(lateClick.error?.code).toBe('ASSISTANT_CHOICE_STALE');
  });

  it('treats a write-tool turn as a pending confirmation, never as a booking', async () => {
    const conversationId = await createConversation();
    const ledgerBefore = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
    turns.push({
      kind: 'sse',
      chunks: sseEnvelope('请确认这笔支出。', {
        toolCall: {
          name: 'transaction.create',
          arguments: {
            type: 'expense',
            amountCents: 2500,
            categoryId: 'builtin-expense-food',
            accountId: 'builtin-default-account',
            date: '2026-09-20',
            note: '午饭',
          },
        },
      }),
    });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_write',
      input: { type: 'text', text: '午饭 25 元' },
    });
    const finished = await waitForTerminal(conversationId, created.generation!.id);
    expect(finished.status).toBe('completed');
    expect(finished.outcome).toBe('pending-confirmation');
    const ledgerAfter = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
    expect(ledgerAfter).toBe(ledgerBefore);
    const card = (finished.messages[0] as { content: { card?: { status: string; writes: boolean } } }).content.card;
    expect(card?.status).toBe('pending');
    expect(card?.writes).toBe(true);
  });

  it('keeps the write card stable when the step announced a provisional bubble id', async () => {
    const conversationId = await createConversation();
    turns.push({
      kind: 'sse',
      chunks: sseEnvelope('请确认这笔支出。', {
        toolCall: {
          name: 'transaction.create',
          arguments: {
            type: 'expense',
            amountCents: 2500,
            categoryId: 'builtin-expense-food',
            accountId: 'builtin-default-account',
            date: '2026-09-20',
            note: '午饭',
          },
        },
      }),
    });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_write_stable_partial',
      input: { type: 'text', text: '午饭 25 元' },
    });
    const finished = await waitForTerminal(conversationId, created.generation!.id);
    expect(finished.status).toBe('completed');
    expect(finished.outcome).toBe('pending-confirmation');
    // The card replaces the step's provisional bubble instead of adding a second one.
    const deltaIds = db
      .prepare("SELECT json_extract(payload_json, '$.messageId') AS id, MIN(seq) AS first FROM assistant_generation_events WHERE generation_id = ? AND type = 'text-delta' GROUP BY id ORDER BY first")
      .all(created.generation!.id) as { id: string; first: number }[];
    expect(deltaIds.length).toBe(1);
    expect(finished.messageIds).toEqual([deltaIds[0]!.id]);
    expect(finished.partialMessages).toEqual([]);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM assistant_generation_events WHERE generation_id = ? AND type = 'message'").get(created.generation!.id) as { c: number }).c,
    ).toBe(1);
    // The card points at the pending action that was persisted with it.
    const pending = db
      .prepare('SELECT id FROM assistant_pending_actions WHERE conversation_id = ?')
      .get(conversationId) as { id: string };
    expect((finished.messages[0] as { content: { card?: { actionId: string } } }).content.card?.actionId).toBe(pending.id);
  });

  it('rejects a clarification that coexists with a tool call', async () => {
    const conversationId = await createConversation();
    turns.push(
      { kind: 'sse', chunks: sseEnvelope('both', { toolCall: { name: 'stats.monthly', arguments: {} }, clarification: { question: 'q', options: ['a', 'b'] } }) },
    );
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_both',
      input: { type: 'text', text: 'hi' },
    });
    const finished = await waitForTerminal(conversationId, created.generation!.id);
    expect(finished.status).toBe('failed');
  });
});

describe('live SSE over a real connection', () => {
  it('delivers the first text before the upstream turn completes, then the terminal frame', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no listening port');
    const base = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { ...CSRF, 'content-type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    const session = String(login.headers.get('set-cookie')).split(';')[0] ?? '';
    const headers = { ...CSRF, Cookie: session };
    const conversation = (await (
      await fetch(`${base}/api/v1/assistant/conversations`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'sse' }),
      })
    ).json()) as { id: string };

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    turns.push({
      kind: 'sse',
      // The opening fragment is the envelope container and must never surface on its own;
      // the first decoded message characters ride in the same pre-gate flush. The gate
      // then holds the rest of the turn open so "text before completion" is observable.
      head: [deltaFrame('{"message":"'), deltaFrame('先到的一段')],
      chunks: [
        deltaFrame('全篇结束'),
        deltaFrame('","toolCall":null,"clarification":null}'),
        deltaFrame('', 'stop'),
        'data: [DONE]\n\n',
      ],
      gate,
    });
    const created = (await (
      await fetch(`${base}/api/v1/assistant/conversations/${conversation.id}/generations`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, clientRequestId: 'req_live_sse', input: { type: 'text', text: 'hi' } }),
      })
    ).json()) as { generation: AssistantGenerationSnapshot };

    const stream = await fetch(
      `${base}/api/v1/assistant/conversations/${conversation.id}/generations/${created.generation.id}/events?afterSeq=0`,
      { headers },
    );
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    // A single in-flight read is kept across polls. Racing a fresh `reader.read()` against
    // a timer and then treating the timer placeholder as `done` would abort the wait after
    // one tick, so an event that legitimately arrives a little later looks like EOF.
    let pendingRead: Promise<Awaited<ReturnType<typeof reader.read>>> | null = null;
    const readUntil = async (needle: string, timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !received.includes(needle)) {
        pendingRead ??= reader.read();
        const read = await Promise.race([
          pendingRead,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 25)),
        ]);
        if (read === null) continue;
        pendingRead = null;
        if (read.value !== undefined) received += decoder.decode(read.value, { stream: true });
        if (read.done) break;
      }
      return received.includes(needle);
    };

    // The partial text must arrive while the provider turn is still open (the gate is
    // unresolved), which is exactly what "real streaming, not simulated typing" means.
    expect(await readUntil('event: text-delta', 3_000)).toBe(true);
    expect(received).not.toContain('event: terminal');
    release();
    // The mock delivers the rest synchronously from the stream's `start()` callback, so
    // `release()` cannot report when the producer actually finished. Confirm the terminal
    // frame through the generation snapshot, which only turns terminal once the whole
    // envelope was validated and the message persisted.
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const snapshot = (await (
        await fetch(`${base}/api/v1/assistant/conversations/${conversation.id}/generations/${created.generation.id}`, { headers })
      ).json()) as { generation: AssistantGenerationSnapshot };
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.generation.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await readUntil('event: terminal', 3_000)).toBe(true);
    expect(received).toContain('全篇结束');
    expect(received).toContain('"status":"completed"');
    await reader.cancel().catch(() => undefined);
  });
});

describe('archival and restart recovery', () => {
  it('fences a live generation when its conversation is archived, with no late message', async () => {
    const conversationId = await createConversation();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    turns.push({ kind: 'sse', chunks: sseEnvelope('迟到的回复'), gate });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_archive',
      input: { type: 'text', text: 'hi' },
    });
    await waitForStatus(conversationId, created.generation!.id, 'running');

    const archived = await inject('DELETE', `/api/v1/assistant/conversations/${conversationId}`);
    expect(archived.statusCode).toBe(200);
    const row = db
      .prepare('SELECT status, outcome FROM assistant_generations WHERE id = ?')
      .get(created.generation!.id) as { status: string; outcome: string | null };
    expect(row.status).toBe('interrupted');
    expect(row.outcome).toBeNull();

    // Late provider output must not resurrect the generation or persist a message.
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = db
      .prepare('SELECT status FROM assistant_generations WHERE id = ?')
      .get(created.generation!.id) as { status: string };
    expect(after.status).toBe('interrupted');
    const messageCount = db
      .prepare("SELECT COUNT(*) AS c FROM assistant_messages WHERE conversation_id = ? AND role = 'assistant'")
      .get(conversationId) as { c: number };
    expect(messageCount.c).toBe(0);
  });

  it('recovers unfinished generations as interrupted on boot without calling the provider', async () => {
    const conversationId = await createConversation();
    turns.push({ kind: 'sse', chunks: sseEnvelope('never used') });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_recover',
      input: { type: 'text', text: 'hi' },
    });
    await waitForTerminal(conversationId, created.generation!.id);

    // Simulate a crash mid-generation: force the row back to running, then boot again.
    db.prepare("UPDATE assistant_generations SET status = 'running', outcome = NULL WHERE id = ?")
      .run(created.generation!.id);
    const before = providerBodies.length;
    const second = buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        JIZHANG_USERNAME: USERNAME,
        JIZHANG_PASSWORD_HASH: 'unused',
        JIZHANG_AI_ENCRYPTION_KEY: KEY,
        DATA_DIR: testDataDir,
      }),
      db,
      secureCookies: false,
      now: () => currentNow,
      fetchImpl: streamingFetch,
      generationDelayMs: 0,
      generationStepDelayMs: 0,
    });
    // Recovery runs while the plugin tree is being built, not in `buildApp` itself.
    await second.ready();
    const recovered = db
      .prepare('SELECT status, error_code FROM assistant_generations WHERE id = ?')
      .get(created.generation!.id) as { status: string; error_code: string | null };
    expect(recovered.status).toBe('interrupted');
    expect(recovered.error_code).toBe('ASSISTANT_GENERATION_INTERRUPTED');
    expect(providerBodies.length).toBe(before);
    await second.close();
  });
});

describe('emoji boundaries in streamed deltas', () => {
  it('keeps offsets contiguous and never emits half of a surrogate pair', async () => {
    const conversationId = await createConversation();
    // Fills the 4000-unit display budget exactly and ends on a surrogate pair, so the
    // coalescing/offset arithmetic is exercised right at the boundary.
    const answer = '字'.repeat(3_998) + '👍';
    turns.push({ kind: 'sse', chunks: sseEnvelope(answer) });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_emoji_budget',
      input: { type: 'text', text: '长回复' },
    });
    const finished = await waitForTerminal(conversationId, created.generation!.id);
    expect(finished.status).toBe('completed');
    const deltas = db
      .prepare("SELECT json_extract(payload_json, '$.text') AS text, json_extract(payload_json, '$.offset') AS offset, json_extract(payload_json, '$.messageId') AS messageId FROM assistant_generation_events WHERE generation_id = ? AND type = 'text-delta' ORDER BY seq")
      .all(created.generation!.id) as { text: string; offset: number; messageId: string }[];
    expect(deltas.length).toBeGreaterThan(0);
    let expectedOffset = 0;
    for (const delta of deltas) {
      expect(delta.offset).toBe(expectedOffset);
      expect(delta.messageId).toBe(finished.messageIds[0]);
      expectedOffset += delta.text.length;
      // No unpaired surrogate anywhere in the emitted text.
      for (let index = 0; index < delta.text.length; index += 1) {
        const code = delta.text.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = delta.text.charCodeAt(index + 1);
          expect(code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff).toBe(true);
        }
        expect(code >= 0xdc00 && code <= 0xdfff && index === 0 && !(delta.text.charCodeAt(-1) >= 0xd800)).toBe(false);
      }
    }
    // The whole displayed answer arrived, and never more than the per-turn budget.
    expect(expectedOffset).toBe(answer.length);
    expect(expectedOffset).toBeLessThanOrEqual(4_000);
    expect((finished.messages[0] as { content: { text: string } }).content.text.endsWith('👍')).toBe(true);
  });
});

describe('buffered provider Unicode boundary', () => {
  it('never persists a lone surrogate when the buffered message ends on an emoji', async () => {
    const conversationId = await createConversation();
    // Buffered delivery (responses/custom) has no tokenizer ceiling, so the raw provider
    // string is the one that reaches the final `message` event and the durable row.
    new AiConfigService(db, { aiEncryptionKey: KEY, production: false, now: () => currentNow }).save({
      enabled: true,
      mode: 'responses',
      name: 'buffered provider',
      url: 'https://provider.example.test/v1/responses',
      method: 'POST',
      model: 'test-model',
      timeoutMs: 5_000,
      headers: {},
      auth: { kind: 'bearer' },
      bodyTemplate: null,
      responsePath: 'choices[0].message.content',
      secret: 'test-only-provider-secret',
    });
    turns.push(bufferedEnvelope({ message: '字'.repeat(3_999) + '😀', toolCall: null, clarification: null }));
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_buffered_emoji_boundary',
      input: { type: 'text', text: '长回复' },
    });
    const finished = await waitForTerminal(conversationId, created.generation!.id);
    expect(finished.status).toBe('completed');
    const text = (finished.messages[0] as { content: { text: string } }).content.text;
    // The 4000-unit budget was not silently widened to keep the emoji: it was dropped as a
    // whole character instead of persisting half of it.
    expect(text.length).toBe(3_999);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      expect(code >= 0xd800 && code <= 0xdbff).toBe(false);
      expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
    }
    // The same safe text is what the durable row and the `message` event carry.
    const row = db
      .prepare("SELECT content_json FROM assistant_messages WHERE conversation_id = ? AND role = 'assistant'")
      .get(conversationId) as { content_json: string };
    expect(JSON.parse(row.content_json).text).toBe(text);
  });
});

describe('unexpected loop failures', () => {
  it('still writes a terminal status instead of leaving the generation running', async () => {
    const conversationId = await createConversation();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    turns.push({ kind: 'sse', chunks: sseEnvelope('半途'), gate });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_loop_throw',
      input: { type: 'text', text: '统计' },
    });
    await waitForStatus(conversationId, created.generation!.id, 'running');
    // Corrupt the provisional snapshot mid-run so an internal parse failure escapes the
    // step loop: the run wrapper must still land a terminal row, never a stuck `running`.
    db.prepare("UPDATE assistant_generations SET partials_json = 'not-json' WHERE id = ?").run(created.generation!.id);
    release();
    // Read the row directly: a corrupt snapshot cannot be read through the API, which is
    // exactly why the status transition itself must still happen.
    let status = '';
    for (let attempt = 0; attempt < 400; attempt += 1) {
      status = (db.prepare('SELECT status FROM assistant_generations WHERE id = ?').get(created.generation!.id) as { status: string }).status;
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(status).toBe('failed');
    const terminal = db
      .prepare("SELECT COUNT(*) AS c FROM assistant_generation_events WHERE generation_id = ? AND type = 'terminal'")
      .get(created.generation!.id) as { c: number };
    expect(terminal.c).toBe(1);
  });
});

describe('legacy and v1 mutual exclusion', () => {
  it('refuses a new generation while a legacy provider turn is in flight', async () => {
    const conversationId = await createConversation();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    turns.push({ kind: 'gated-envelope', value: { message: '旧入口回复', toolCall: null, clarification: null }, gate });

    const legacy = Promise.resolve(inject('POST', `/api/v1/assistant/conversations/${conversationId}/messages`, {
      text: '旧入口问题',
      clientRequestId: 'legacy_blocking_1',
    }));
    // The orchestrator persists a `running` progress bubble before it calls the provider,
    // which is proof the legacy turn already holds the exclusion.
    await waitFor(async () => {
      const response = await inject('GET', `/api/v1/assistant/conversations/${conversationId}/messages`);
      const items = (response.json() as { items: { content: { progress?: { state: string } } }[] }).items;
      return items.some((message) => message.content.progress?.state === 'running') ? true : null;
    });
    const blocked = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_during_legacy',
      input: { type: 'text', text: '新入口问题' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.error?.code).toBe('ASSISTANT_GENERATION_ACTIVE');

    release();
    const legacyResponse = await legacy;
    expect(legacyResponse.statusCode).toBe(200);

    // Once the legacy turn finished the v1 entry point is open again.
    turns.push({ kind: 'sse', chunks: sseEnvelope('可以了') });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_after_legacy',
      input: { type: 'text', text: '现在可以了吗' },
    });
    expect(created.statusCode).toBe(202);
    expect((await waitForTerminal(conversationId, created.generation!.id)).status).toBe('completed');
  });
});

describe('streamed tool steps, wrong-conversation cancel and dedup', () => {
  it('persists read-tool narration under its own provisional bubble id', async () => {
    const conversationId = await createConversation();
    // A read tool buys an extra closed set: the narration of step 0 must be durable (the
    // client can already see it) and must reuse the bubble id announced for *that* step.
    turns.push({ kind: 'sse', chunks: sseEnvelope('我先查一下最近的账单。', { toolCall: { name: 'transactions.recent', arguments: { limit: 5 } } }) });
    turns.push({ kind: 'sse', chunks: sseEnvelope('最近没有新的账单。') });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_tool_narration',
      input: { type: 'text', text: '最近有什么账单' },
    });
    const finished = await waitForTerminal(conversationId, created.generation!.id);
    expect(finished.status).toBe('completed');
    expect(finished.outcome).toBe('answer');
    // One bubble per streamed step: the narration, then the answer.
    expect(finished.messageIds.length).toBe(2);
    expect((finished.messages[0] as { kind: string }).kind).toBe('text');
    expect((finished.messages[0] as { content: { text: string } }).content.text).toBe('我先查一下最近的账单。');
    expect((finished.messages[1] as { kind: string }).kind).toBe('result');
    // The narration was persisted under the id the step announced, not an orphan one.
    const deltaIds = db
      .prepare("SELECT json_extract(payload_json, '$.messageId') AS id, MIN(seq) AS first FROM assistant_generation_events WHERE generation_id = ? AND type = 'text-delta' GROUP BY id ORDER BY first")
      .all(created.generation!.id) as { id: string; first: number }[];
    expect(deltaIds.map((row) => row.id)).toEqual([...finished.messageIds]);
    // Each bubble has exactly one `message` event and no lingering provisional snapshot.
    const messageEvents = db
      .prepare("SELECT COUNT(*) AS c FROM assistant_generation_events WHERE generation_id = ? AND type = 'message'")
      .get(created.generation!.id) as { c: number };
    expect(messageEvents.c).toBe(2);
    expect(finished.partialMessages).toEqual([]);
    expect(providerBodies.length).toBe(2);
  });

  it('refuses a cancel addressed through the wrong conversation without aborting it', async () => {
    const conversationId = await createConversation();
    const otherConversationId = await createConversation();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    turns.push({ kind: 'sse', chunks: sseEnvelope('还在生成'), gate });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_wrong_conv_cancel',
      input: { type: 'text', text: '统计' },
    });
    await waitForStatus(conversationId, created.generation!.id, 'running');

    const wrong = await inject(
      'POST',
      `/api/v1/assistant/conversations/${otherConversationId}/generations/${created.generation!.id}/cancel`,
    );
    expect(wrong.statusCode).toBe(404);
    expect((wrong.json() as { error: { code: string } }).error.code).toBe('ASSISTANT_GENERATION_NOT_FOUND');
    // Ownership is enforced *before* anything is aborted: the real generation still runs.
    expect((await inject('GET', `/api/v1/assistant/conversations/${conversationId}/generations/${created.generation!.id}`)).json())
      .toMatchObject({ generation: { status: 'running' } });

    release();
    const finished = await waitForTerminal(conversationId, created.generation!.id);
    expect(finished.status).toBe('completed');
  });

  it('fails a generation whose streamed tool call is invalid, with no message persisted', async () => {
    const conversationId = await createConversation();
    turns.push({
      kind: 'sse',
      chunks: sseEnvelope('我准备记录这笔支出。', {
        toolCall: { name: 'transaction.create', arguments: { type: 'expense' } },
      }),
    });
    const created = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'req_invalid_tool',
      input: { type: 'text', text: '午饭 25' },
    });
    const finished = await waitForTerminal(conversationId, created.generation!.id);
    expect(finished.status).toBe('failed');
    expect(finished.outcome).toBeNull();
    expect(finished.messageIds).toEqual([]);
    expect(finished.error?.code).toBe('ASSISTANT_STREAM_BOUNDS');
    const assistantCount = db
      .prepare("SELECT COUNT(*) AS c FROM assistant_messages WHERE conversation_id = ? AND role = 'assistant'")
      .get(conversationId) as { c: number };
    expect(assistantCount.c).toBe(0);
  });
});

describe('legacy exclusion cleanup', () => {
  it('does not leave the conversation busy after invalid attachment validation', async () => {
    const id = await createConversation();
    const invalid = await inject('POST', `/api/v1/assistant/conversations/${id}/messages`, {
      text: 'test', attachment: { fileName: 'invalid.pdf', fileBase64: 'aGVsbG8=' },
    });
    expect(invalid.statusCode).toBe(400);
    turns.push({ kind: 'sse', chunks: sseEnvelope('ready') });
    const next = await createGeneration(id, {
      version: 1, clientRequestId: 'after-invalid-attachment', input: { type: 'text', text: 'hello' },
    });
    expect(next.statusCode).toBe(202);
    expect((await waitForTerminal(id, next.generation!.id)).status).toBe('completed');
  });
});

describe('background history organization', () => {
  it('keeps the analysis alive after answering a date clarification', async () => {
    db.prepare(`INSERT INTO transactions
      (id,type,amount_cents,category_id,account_id,date,note,tags_json,is_refund,deleted,updated_at)
      VALUES ('history-bill',0,100,'builtin-expense-food','builtin-default-account',?,'','[]',0,0,?)`).run(NOW, NOW);
    const conversation = await createConversation();
    turns.push({ kind: 'sse', chunks: sseEnvelope('请选择范围', {
      clarification: { question: '选择日期范围', options: ['本月', '上月'] },
    }) });
    const first = await createGeneration(conversation, {
      version: 1, clientRequestId: 'history-question', input: { type: 'text', text: '整理历史账单' },
    });
    const question = clarificationOf(await waitForTerminal(conversation, first.generation!.id));
    let release!: () => void;
    spendingGate = new Promise<void>((resolve) => { release = resolve; });
    turns.push(
      { kind: 'sse', chunks: sseEnvelope('开始分析', { toolCall: {
        name: 'spending.preview', arguments: { startDate: '2026-09-01', endDate: '2026-09-30' },
      } }) },
      { kind: 'sse', chunks: sseEnvelope('分析已在后台开始') },
    );
    try {
      const second = await createGeneration(conversation, {
        version: 1, clientRequestId: 'history-answer', input: {
          type: 'choice', sourceGenerationId: first.generation!.id,
          questionId: question.id, optionId: question.options[0]!.id,
        },
      });
      const completed = await waitForTerminal(conversation, second.generation!.id);
      expect(completed.status).toBe('completed');
      await waitFor(async () => spendingSignal ? true : null);
      expect(spendingSignal?.aborted).toBe(false);
      release();
      await waitFor(async () => {
        const row = db.prepare('SELECT status FROM ai_analysis_runs ORDER BY created_at DESC LIMIT 1').get() as {status: string} | undefined;
        return row?.status === 'ready' ? true : null;
      });
    } finally { release(); spendingGate = undefined; }
  });
});

describe('nested provider cancellation', () => {
  it('stops while an advisory read tool waits for its nested provider', async () => {
    const id = await createConversation();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    turns.push(
      { kind: 'sse', chunks: sseEnvelope('Preparing a monthly explanation', {
        toolCall: { name: 'monthly.evaluate', arguments: {} },
      }) },
      { kind: 'gated-envelope', gate, value: {} },
    );
    const created = await createGeneration(id, {
      version: 1, clientRequestId: 'cancel-nested-provider', input: { type: 'text', text: 'monthly explanation' },
    });
    try {
      await waitFor(async () => providerBodies.length >= 2 ? true : null);
      const started = Date.now();
      const cancelled = await inject('POST', `/api/v1/assistant/conversations/${id}/generations/${created.generation!.id}/cancel`);
      expect(cancelled.statusCode).toBe(200);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(cancelled.json().generation.status).toBe('cancelled');
      expect((db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c).toBe(0);
    } finally {
      release();
    }
  });
});

/**
 * Seeds a visible ledger row plus two live categories with the same normalized name, so
 * `organization.preview` reports at least one `ready` action and `organization.apply`
 * produces a real pending card (never a booking).
 */
function seedOrganizationMerges(): void {
  db.prepare(
    `INSERT INTO transactions
       (id, type, amount_cents, category_id, account_id, date, note, tags_json, is_refund, deleted, updated_at)
     VALUES ('org-tx', 0, 100, 'builtin-expense-food', 'builtin-default-account', ?, '', '[]', 0, 0, ?)`,
  ).run(currentNow, currentNow);
  for (const id of ['org-merge-source', 'org-merge-target']) {
    db.prepare(
      `INSERT INTO categories
         (id, name, type, parent_id, icon, color, sort_order, is_builtin, deleted, updated_at)
       VALUES (?, '同名分类', 0, NULL, 'folder', 1, 20, 0, 0, ?)`,
    ).run(id, currentNow);
  }
}

describe('nested provider cancellation and deadline for a write-tool prepare', () => {
  it('stops while organization.apply waits for its nested provider', async () => {
    const id = await createConversation();
    seedOrganizationMerges();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    turns.push(
      { kind: 'sse', chunks: sseEnvelope('I will prepare a merge card.', {
        toolCall: { name: 'organization.apply', arguments: { actionIds: [ORG_READY_ACTION_ID] } },
      }) },
      { kind: 'gated-envelope', gate, value: {} },
    );
    const created = await createGeneration(id, {
      version: 1, clientRequestId: 'cancel-nested-write-prepare', input: { type: 'text', text: '整理一下账本' },
    });
    try {
      // The nested provider request is issued by `prepare`, and is gated there.
      await waitFor(async () => providerBodies.length >= 2 ? true : null);
      const started = Date.now();
      const cancelled = await inject('POST', `/api/v1/assistant/conversations/${id}/generations/${created.generation!.id}/cancel`);
      expect(cancelled.statusCode).toBe(200);
      // The Stop must not wait for the nested provider's own timeout.
      expect(Date.now() - started).toBeLessThan(1000);
      expect(cancelled.json().generation.status).toBe('cancelled');
      // No late card, no pending action and no ledger write.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS c FROM assistant_pending_actions').get() as { c: number }).c).toBe(0);
      const cards = db
        .prepare("SELECT COUNT(*) AS c FROM assistant_messages WHERE conversation_id = ? AND role = 'assistant'")
        .get(id) as { c: number };
      expect(cards.c).toBe(0);
    } finally {
      release();
    }
  });

  it('fails the generation when a nested provider prepare outlives the deadline', async () => {
    const id = await createConversation();
    seedOrganizationMerges();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    turns.push(
      { kind: 'sse', chunks: sseEnvelope('Please confirm this merge.', {
        toolCall: { name: 'organization.apply', arguments: { actionIds: [ORG_READY_ACTION_ID] } },
      }) },
      { kind: 'gated-envelope', gate, value: {} },
    );
    const created = await createGeneration(id, {
      version: 1, clientRequestId: 'deadline-nested-write-prepare', input: { type: 'text', text: '整理一下账本' },
    });
    await waitFor(async () => providerBodies.length >= 2 ? true : null);
    // The nested provider resolved, but the wall clock is now past the 180 s generation
    // deadline: the ready card must not be committed as a completed generation.
    currentNow = NOW + 181_000;
    release();
    const finished = await waitForTerminal(id, created.generation!.id);
    expect(finished.status).toBe('failed');
    expect(finished.outcome).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS c FROM assistant_pending_actions').get() as { c: number }).c).toBe(0);
    const cards = db
      .prepare("SELECT COUNT(*) AS c FROM assistant_messages WHERE conversation_id = ? AND role = 'assistant'")
      .get(id) as { c: number };
    expect(cards.c).toBe(0);
  });
});

it('labels a noncanonical Chat extraction as buffered before starting provider work', async () => {
  const id = await createConversation();
  const settings = db.prepare('SELECT value_json FROM settings WHERE key = ?').get('ai.provider.v1') as { value_json: string };
  const saved = JSON.parse(settings.value_json) as Record<string, unknown>;
  saved['responsePath'] = 'choices[0].message';
  db.prepare('UPDATE settings SET value_json = ? WHERE key = ?').run(JSON.stringify(saved), 'ai.provider.v1');
  turns.push(bufferedEnvelope({ message: 'buffered', toolCall: null }));
  const result = await createGeneration(id, {
    version: 1, clientRequestId: 'noncanonical-chat-path', input: { type: 'text', text: 'hello' },
  });
  expect(result.generation?.delivery).toBe('buffered');
  await waitForTerminal(id, result.generation!.id);
  expect((providerBodies[0] as Record<string, unknown>)['stream']).not.toBe(true);
});

/**
 * Regression for the device-reported stuck question (task 10-15): a generation that
 * consumes a choice used to copy the source's `answered_option_id`/`answered_at` into its
 * own row at INSERT, so the next generation's own clarification could never be answered
 * (`ASSISTANT_CHOICE_STALE`). Provenance stays in `source_generation_id`, the stored
 * `question_id`/`question_json` and `input_json`, and the consumed answer stays on the
 * source row only.
 */
describe('chained clarification choices', () => {
  /** Serves one turns' clarification prompt, then answers it and serves the next prompt. */
  async function firstTwoHops(
    conversationId: string,
    requestPrefix: string,
  ): Promise<{ genA: AssistantGenerationSnapshot; genB: AssistantGenerationSnapshot; qB: { id: string; options: { id: string; label: string }[] } }> {
    turns.push({
      kind: 'sse',
      chunks: sseEnvelope('请选择分类', { clarification: { question: '分类？', options: ['餐饮', '娱乐'] } }),
    });
    const first = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: `${requestPrefix}_text`,
      input: { type: 'text', text: '午饭' },
    });
    expect(first.statusCode).toBe(202);
    const genA = await waitForTerminal(conversationId, first.generation!.id);
    expect(genA.outcome).toBe('awaiting-choice');
    const qA = clarificationOf(genA);
    // A generation that asks a question has not answered anything yet.
    expect(answerState(genA.id)).toEqual({ answeredOptionId: null, answeredAt: null });

    turns.push({
      kind: 'sse',
      chunks: sseEnvelope('请选择账户', { clarification: { question: '账户？', options: ['微信', '银行卡'] } }),
    });
    const second = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: `${requestPrefix}_choice`,
      input: {
        type: 'choice',
        sourceGenerationId: genA.id,
        questionId: qA.id,
        optionId: qA.options[0]!.id,
      },
    });
    expect(second.statusCode).toBe(202);
    const genB = await waitForTerminal(conversationId, second.generation!.id);
    expect(genB.outcome).toBe('awaiting-choice');

    // The consumption is recorded on the source only...
    expect(answerState(genA.id).answeredOptionId).toBe(qA.options[0]!.id);
    expect(answerState(genA.id).answeredAt).not.toBeNull();
    // ...while the new generation stays unanswered until its own question is consumed.
    expect(answerState(genB.id)).toEqual({ answeredOptionId: null, answeredAt: null });
    // Provenance survives without the answer columns.
    expect(storedInput(genB.id)).toEqual({
      type: 'choice',
      sourceGenerationId: genA.id,
      questionId: qA.id,
      optionId: qA.options[0]!.id,
    });
    return { genA, genB, qB: clarificationOf(genB) };
  }

  it('continues through text -> question A -> choice -> question B -> choice', async () => {
    const conversationId = await createConversation();
    const ledgerBefore = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
    const { genA, genB, qB } = await firstTwoHops(conversationId, 'chained_option');

    turns.push({ kind: 'sse', chunks: sseEnvelope('好的，已记录为微信。') });
    const third = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'chained_option_second_answer',
      input: {
        type: 'choice',
        sourceGenerationId: genB.id,
        questionId: qB.id,
        optionId: qB.options[0]!.id,
      },
    });
    expect(third.statusCode).toBe(202);
    const genC = await waitForTerminal(conversationId, third.generation!.id);
    expect(genC.status).toBe('completed');
    expect(genC.outcome).toBe('answer');
    expect((genC.userMessage as { content: { text: string } }).content.text).toBe(qB.options[0]!.label);
    // genC asked nothing, so it never carries an answer of its own either.
    expect(answerState(genB.id).answeredOptionId).toBe(qB.options[0]!.id);
    expect(answerState(genC.id)).toEqual({ answeredOptionId: null, answeredAt: null });

    // A second click on genB's (already consumed) question is stale, even with a fresh id.
    const stale = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'chained_option_second_stale',
      input: {
        type: 'choice',
        sourceGenerationId: genB.id,
        questionId: qB.id,
        optionId: qB.options[1]!.id,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.error?.code).toBe('ASSISTANT_CHOICE_STALE');

    // genA is likewise consumed and remains rejected.
    const staleA = await createGeneration(conversationId, {
      version: 1,
      clientRequestId: 'chained_option_first_stale',
      input: {
        type: 'choice',
        sourceGenerationId: genA.id,
        questionId: clarificationOf(genA).id,
        optionId: clarificationOf(genA).options[1]!.id,
      },
    });
    expect(staleA.statusCode).toBe(409);
    expect(staleA.error?.code).toBe('ASSISTANT_CHOICE_STALE');

    const ledgerAfter = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
    expect(ledgerAfter).toBe(ledgerBefore);
  });

  it('continues through choice-text at the second hop and keeps the replay idempotent', async () => {
    const conversationId = await createConversation();
    const ledgerBefore = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
    const { genB, qB } = await firstTwoHops(conversationId, 'chained_freetext');

    const body = {
      version: 1,
      clientRequestId: 'chained_freetext_second_answer',
      input: {
        type: 'choice-text',
        sourceGenerationId: genB.id,
        questionId: qB.id,
        text: 'This is only a test, do not book any expense',
      },
    };
    turns.push({ kind: 'sse', chunks: sseEnvelope('好，按你说的办。') });
    const third = await createGeneration(conversationId, body);
    expect(third.statusCode).toBe(202);
    const genC = await waitForTerminal(conversationId, third.generation!.id);
    expect(genC.status).toBe('completed');
    expect((genC.userMessage as { content: { text: string } }).content.text).toBe(
      'This is only a test, do not book any expense',
    );
    // choice-text records no option id on the source, only the consumption timestamp.
    expect(answerState(genB.id)).toEqual({ answeredOptionId: null, answeredAt: expect.any(Number) });
    expect(answerState(genC.id)).toEqual({ answeredOptionId: null, answeredAt: null });

    const providerCalls = providerBodies.length;
    const replay = await createGeneration(conversationId, body);
    expect(replay.statusCode).toBe(200);
    expect(replay.created).toBe(false);
    expect(replay.generation?.id).toBe(third.generation!.id);
    expect(providerBodies.length).toBe(providerCalls);

    const ledgerAfter = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
    expect(ledgerAfter).toBe(ledgerBefore);
  });
});
