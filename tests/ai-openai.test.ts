/** OpenAI 接入:真实设置 / 路由 / 记录器,只在 HTTP 和浏览器存储边界使用替身。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiRequest } from '../src/ai/types';

const KEY = 'test-openai-secret-0123456789'; // 不靠通用 sk- 正则也必须遮掉已保存的密钥
const REQ: AiRequest = { feature: '连接测试', messages: [{ role: 'user', content: '你好' }], temperature: 0, maxTokens: 600 };

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, String(value)); }
}

async function loadApp() {
  vi.resetModules();
  const settings = await import('../src/ai/settings');
  const client = await import('../src/ai/client');
  const log = await import('../src/ai/callLog');
  const { setOfficialServerForTest } = await import('../src/ai/providers/official');
  setOfficialServerForTest(null);
  const { setupAi } = await import('../src/ai/setup');
  setupAi();
  await log.initCallLog(null);
  return { ...settings, ...client, ...log };
}

let app: Awaited<ReturnType<typeof loadApp>>;
let storage: MemoryStorage;
const fetchMock = vi.fn<typeof fetch>();

// 和 OpenAI 的 chat.completion.chunk 一样;每次读取拆成 7 字节,包括跨汉字边界。
function stream(deltas: Record<string, unknown>[] = [{ content: '你好' }], finish = 'stop') {
  const base = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1773705600, model: 'gpt-5.4-mini-2026-03-17', system_fingerprint: null };
  const events = [
    ...deltas.map((delta) => ({ ...base, choices: [{ index: 0, delta, logprobs: null, finish_reason: null }], usage: null })),
    { ...base, choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: finish }], usage: null },
    { ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } } },
  ];
  const bytes = new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n');
  let at = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (at >= bytes.length) return ctl.close();
      ctl.enqueue(bytes.slice(at, at + 7));
      at += 7;
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

const outputMessage = (text: string) => ({ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [], logprobs: [] }] });

/** Responses 的完整结束对象,不是 Chat Completions 的 choices。 */
function responseFixture(output: unknown[] = [outputMessage('你好')], patch: Record<string, unknown> = {}) {
  return {
    id: 'resp_test', object: 'response', created_at: 1793491200, completed_at: 1793491201,
    status: 'completed', error: null, incomplete_details: null, model: 'gpt-6.1-terra', output,
    instructions: null, max_output_tokens: 600, previous_response_id: null, store: false,
    reasoning: { effort: 'none', summary: null }, text: { format: { type: 'text' } },
    temperature: 0, top_p: 1, tool_choice: 'auto', tools: [], parallel_tool_calls: true,
    truncation: 'disabled', metadata: {}, user: null,
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    ...patch,
  };
}

function responseStream(final = responseFixture(), events: Record<string, unknown>[] = [], complete = true) {
  const all = [...events, ...(complete ? [{ type: `response.${final.status}`, response: final }] : [])];
  const bytes = new TextEncoder().encode(all.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''));
  let at = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (at >= bytes.length) return ctl.close();
      ctl.enqueue(bytes.slice(at, at + 7));
      at += 7;
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

function request(index = 0) {
  const [url, init] = fetchMock.mock.calls[index];
  return { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)), init };
}

function configure(model = 'gpt-5.4-mini') {
  app.setSecret('openai', KEY);
  app.updateAiSettings({ openai: { model } });
  app.chooseProvider('openai');
}

beforeEach(async () => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  fetchMock.mockReset().mockImplementation(async (url) => String(url).endsWith('/responses') ? responseStream() : stream());
  vi.stubGlobal('fetch', fetchMock);
  app = await loadApp();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('OpenAI', () => {
  it('没密钥不联网;填入独立密钥后直连 OpenAI,流式 JSON、用量和记录完整', async () => {
    app.setSecret('deepseek', 'other-provider-secret');
    app.chooseProvider('openai');
    expect(app.getAiStatus()).toMatchObject({ provider: 'openai', ready: false });
    await expect(app.aiChat(REQ)).rejects.toMatchObject({ code: 'not-configured' });
    expect(fetchMock).not.toHaveBeenCalled();

    configure();
    expect(app.getAiStatus()).toMatchObject({ provider: 'openai', ready: true });
    fetchMock.mockImplementation(async () => stream([{ role: 'assistant', content: '' }, { content: '{"名":' }, { content: '"碧溪"}' }]));
    const delta = vi.fn();
    const result = await app.aiChat({ ...REQ, json: true }, { onDelta: delta });
    expect(result).toMatchObject({ provider: 'openai', model: 'gpt-5.4-mini-2026-03-17', text: '{"名":"碧溪"}', usage: { inputTokens: 12, outputTokens: 8 } });
    expect(delta.mock.calls).toEqual([['{"名":', '{"名":'], ['"碧溪"}', '{"名":"碧溪"}']]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = request();
    expect(sent.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(sent.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(sent.init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(sent.body).toEqual({
      model: 'gpt-5.4-mini',
      messages: [{ role: 'system', content: expect.stringMatching(/json/i) }, { role: 'user', content: '你好' }],
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 600,
      response_format: { type: 'json_object' },
      reasoning_effort: 'none',
    });
    expect(app.getCallLog().calls[0]).toMatchObject({ provider: 'openai', ok: true, text: '{"名":"碧溪"}', usage: { inputTokens: 12, outputTokens: 8 } });
    expect(JSON.stringify(app.getCallLog().calls)).not.toContain(KEY);
  });

  it.each(['gpt-5.4', 'gpt-5.4-nano', 'gpt-5.4-mini-2026-03-17'])('GPT-5.4 系列及快照 %s 关闭推理,保留功能给的 token 上限', async (model) => {
    configure(model);
    await app.aiChat(REQ);
    expect(request().body).toMatchObject({ model, max_completion_tokens: 600, reasoning_effort: 'none' });
    expect(request().body).not.toHaveProperty('max_tokens');
    expect(request().body).not.toHaveProperty('temperature');
  });

  it.each([
    ['gpt-4.1-mini', { temperature: 0 }],
    ['o3-mini', {}],
    ['gpt-5-mini', {}],
  ])('手填 %s 使用选定模型;不把非兼容参数传给推理模型', async (model, sampling) => {
    configure(model);
    await app.aiChat(REQ);
    expect(request().body).toEqual({ model, messages: [{ role: 'user', content: '你好' }], stream: true, stream_options: { include_usage: true }, max_completion_tokens: 600, ...sampling });
  });

  it('助手的工具调用分段拼回,下一轮带调用 id 和工具结果交回 OpenAI', async () => {
    configure();
    fetchMock.mockImplementationOnce(async () => stream([
      { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_country', type: 'function', function: { name: 'country', arguments: '' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '{"country":' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '"P3"}' } }] },
    ], 'tool_calls'));
    const req: AiRequest = {
      ...REQ,
      tools: [{ name: 'country', description: '查国家', parameters: { type: 'object', properties: { country: { type: 'string' } }, required: ['country'] } }],
      toolChoice: 'required',
    };
    const first = await app.aiChat(req);
    expect(first.toolCalls).toEqual([{ id: 'call_country', name: 'country', args: '{"country":"P3"}' }]);
    expect(first.text).toBe('');
    expect(request().body.tools).toEqual([{ type: 'function', function: { name: 'country', description: '查国家', parameters: { type: 'object', properties: { country: { type: 'string' } }, required: ['country'] } } }]);
    expect(request().body.tool_choice).toBe('required');
    await app.aiChat({ ...req, toolChoice: 'none', messages: [...REQ.messages,
      { role: 'assistant', content: '', toolCalls: first.toolCalls },
      { role: 'tool', toolCallId: 'call_country', content: 'P3 大昌王朝' },
    ] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(request(1).body.messages).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_country', type: 'function', function: { name: 'country', arguments: '{"country":"P3"}' } }] },
      { role: 'tool', tool_call_id: 'call_country', content: 'P3 大昌王朝' },
    ]);
    expect(request(1).body.tool_choice).toBe('none');
  });

  it.each([
    [401, 'invalid_api_key', 'auth', '密钥'],
    [429, 'insufficient_quota', 'quota', '额度'],
    [429, 'rate_limit_exceeded', 'rate-limit', '等一会儿'],
    [404, 'model_not_found', 'other', '模型'],
  ])('HTTP %i / %s 给出正确恢复建议,错误与记录遮掉 OpenAI 密钥', async (status, code, expected, advice) => {
    configure();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: `OpenAI rejected credential ${KEY}`, code, type: code, param: null } }), { status }));
    await expect(app.aiChat(REQ)).rejects.toMatchObject({ code: expected, message: expect.stringContaining(advice) });
    const record = app.getCallLog().calls[0];
    expect(record).toMatchObject({ provider: 'openai', ok: false, error: { code: expected } });
    expect(JSON.stringify(record)).not.toContain(KEY);
    if (code === 'invalid_api_key') expect(record.error?.message).toContain('***');
  });

  it('记住密钥时重载恢复 provider、手填模型和独立密钥;清除后重载不能再调用', async () => {
    configure('gpt-4.1-mini-2025-04-14');
    app = await loadApp();
    await app.aiChat(REQ);
    expect(request().body.model).toBe('gpt-4.1-mini-2025-04-14');
    expect(request().headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(app.getAiStatus()).toMatchObject({ provider: 'openai', ready: true });
    app.setSecret('openai', undefined);
    app = await loadApp();
    await expect(app.aiChat(REQ)).rejects.toMatchObject({ code: 'not-configured' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storage.getItem('civ-atlas:ai-secrets')).toBeNull();
  });

  it('取消记住立即删除已存密钥,当前页面仍能调用,重载后不再联网', async () => {
    configure();
    expect(storage.getItem('civ-atlas:ai-secrets')).toContain(KEY);
    app.updateAiSettings({ remember: false });
    expect(storage.getItem('civ-atlas:ai-secrets')).toBeNull();
    await app.aiChat(REQ);
    expect(request().headers.get('authorization')).toBe(`Bearer ${KEY}`);
    app = await loadApp();
    await expect(app.aiChat(REQ)).rejects.toMatchObject({ code: 'not-configured' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('只有 OpenAI 密钥时,重新勾选记住也会持久化', async () => {
    app.updateAiSettings({ remember: false });
    configure();
    expect(storage.getItem('civ-atlas:ai-secrets')).toBeNull();
    app.updateAiSettings({ remember: true });
    app = await loadApp();
    await app.aiChat(REQ);
    expect(request().headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  describe('GPT-6.1 Terra / Responses API', () => {
    beforeEach(() => {
      // 不手动设 model:验证新用户实际发出的是用户指定的默认模型。
      app.setSecret('openai', KEY);
      app.chooseProvider('openai');
    });

    it('默认模型走 Responses,关闭推理且不存服务端会话;JSON、流式文字与用量返回给调用者', async () => {
      const final = responseFixture([outputMessage('{"名":"碧溪"}')]);
      fetchMock.mockImplementation(async () => responseStream(final, [
        { type: 'response.output_text.delta', item_id: 'msg_test', output_index: 0, content_index: 0, delta: '{"名":', logprobs: [] },
        { type: 'response.output_text.delta', item_id: 'msg_test', output_index: 0, content_index: 0, delta: '"碧溪"}', logprobs: [] },
      ]));
      const delta = vi.fn();
      const result = await app.aiChat({ ...REQ, json: true }, { onDelta: delta });
      expect(request().url).toBe('https://api.openai.com/v1/responses');
      expect(request().headers.get('authorization')).toBe(`Bearer ${KEY}`);
      expect(request().init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer' });
      expect(request().body).toEqual({
        model: 'gpt-6.1-terra', input: [{ role: 'system', content: expect.stringMatching(/json/i) }, { role: 'user', content: '你好' }],
        stream: true, store: false, reasoning: { effort: 'none' }, temperature: 0, max_output_tokens: 600, text: { format: { type: 'json_object' } },
      });
      expect(result).toMatchObject({ provider: 'openai', model: 'gpt-6.1-terra', text: '{"名":"碧溪"}', usage: { inputTokens: 12, outputTokens: 8 } });
      expect(delta.mock.calls).toEqual([['{"名":', '{"名":'], ['"碧溪"}', '{"名":"碧溪"}']]);
      expect(app.getCallLog().calls[0]).toMatchObject({ provider: 'openai', model: 'gpt-6.1-terra', ok: true, usage: { inputTokens: 12, outputTokens: 8 } });
      expect(JSON.stringify(app.getCallLog().calls)).not.toContain(KEY);
    });

    it('多个工具调用以最终完整参数为准,使用 call_id 回传结果;可选参数保持非严格模式', async () => {
      const tools = [{ name: 'country', description: '查国家', parameters: { type: 'object', properties: { country: { type: 'string' } } } }];
      const calls = [
        { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'country', arguments: '{"country":"P3"}', status: 'completed' },
        { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'country', arguments: '{}', status: 'completed' },
      ];
      fetchMock.mockImplementationOnce(async () => responseStream(responseFixture([outputMessage('先查一下'), ...calls]), [
        { type: 'response.function_call_arguments.delta', item_id: 'fc_a', output_index: 1, delta: '{"country":' },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_b', output_index: 2, delta: '{}' },
        { type: 'response.function_call_arguments.delta', item_id: 'fc_a', output_index: 1, delta: '"P3"}' },
      ]));
      const first = await app.aiChat({ ...REQ, tools, toolChoice: 'required' });
      expect(first.text).toBe('先查一下');
      expect(first.toolCalls).toEqual([{ id: 'call_a', name: 'country', args: '{"country":"P3"}' }, { id: 'call_b', name: 'country', args: '{}' }]);
      expect(request().body.tools).toEqual([{ type: 'function', name: 'country', description: '查国家', parameters: { type: 'object', properties: { country: { type: 'string' } } }, strict: false }]);
      expect(request().body.tool_choice).toBe('required');
      const second = await app.aiChat({ ...REQ, tools, toolChoice: 'none', messages: [...REQ.messages,
        { role: 'assistant', content: first.text, toolCalls: first.toolCalls },
        { role: 'tool', toolCallId: 'call_a', content: '大昌王朝' },
        { role: 'tool', toolCallId: 'call_b', content: '全部国家' },
      ] });
      expect(second.text).toBe('你好');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(request(1).url).toBe('https://api.openai.com/v1/responses');
      expect(request(1).body.input).toEqual([
        { role: 'user', content: '你好' }, { role: 'assistant', content: '先查一下' },
        { type: 'function_call', call_id: 'call_a', name: 'country', arguments: '{"country":"P3"}' },
        { type: 'function_call', call_id: 'call_b', name: 'country', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_a', output: '大昌王朝' },
        { type: 'function_call_output', call_id: 'call_b', output: '全部国家' },
      ]);
      expect(request(1).body.tool_choice).toBe('none');
    });

    it('只回工具调用仍可执行,交回工具结果后允许空收尾;缺 call_id 的工具不能执行', async () => {
      const tools = [{ name: 'country', description: '查国家', parameters: { type: 'object', properties: {} } }];
      const call = { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'country', arguments: '{}', status: 'completed' };
      fetchMock.mockImplementationOnce(async () => responseStream(responseFixture([call])));
      const first = await app.aiChat({ ...REQ, tools });
      expect(first).toMatchObject({ text: '', toolCalls: [{ id: 'call_a', name: 'country', args: '{}' }] });
      fetchMock.mockImplementationOnce(async () => responseStream(responseFixture([])));
      expect(await app.aiChat({ ...REQ, tools, messages: [...REQ.messages,
        { role: 'assistant', content: '', toolCalls: first.toolCalls },
        { role: 'tool', toolCallId: 'call_a', content: '大昌王朝' },
      ] })).toMatchObject({ text: '' });
      expect(request(1).body.input).toEqual([
        { role: 'user', content: '你好' },
        { type: 'function_call', call_id: 'call_a', name: 'country', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_a', output: '大昌王朝' },
      ]);
      fetchMock.mockImplementationOnce(async () => responseStream(responseFixture([{ ...call, call_id: undefined }])));
      await expect(app.aiChat({ ...REQ, tools })).rejects.toMatchObject({ code: 'bad-response' });
    });

    it('流式输出途中取消会中止请求,不能把已收到的部分文字当成成功', async () => {
      const ac = new AbortController();
      let sawDelta!: () => void;
      const received = new Promise<void>((resolve) => { sawDelta = resolve; });
      fetchMock.mockImplementation(async (_url, init) => new Response(new ReadableStream({
        start(ctl) {
          init?.signal?.addEventListener('abort', () => ctl.error(new DOMException('aborted', 'AbortError')));
          ctl.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","item_id":"msg_test","output_index":0,"content_index":0,"delta":"一半","logprobs":[],"sequence_number":0}\n\n'));
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } }));
      const result = app.aiChat(REQ, { signal: ac.signal, onDelta: sawDelta }).catch((e) => e);
      await received;
      ac.abort();
      expect(await result).toMatchObject({ code: 'aborted' });
      expect(request().init?.signal?.aborted).toBe(true);
      expect(app.getCallLog().calls[0]).toMatchObject({ ok: false, error: { code: 'aborted' } });
    });

    it('收到普通 JSON 的完成对象也能读取,但只有 SDK 才有的 output_text 不是必要字段', async () => {
      fetchMock.mockImplementation(async () => new Response(JSON.stringify(responseFixture()), { headers: { 'Content-Type': 'application/json' } }));
      const delta = vi.fn();
      expect(await app.aiChat(REQ, { onDelta: delta })).toMatchObject({ text: '你好', usage: { inputTokens: 12, outputTokens: 8 } });
      expect(delta.mock.calls).toEqual([['你好', '你好']]);
    });

    it.each([
      ['incomplete', { reason: 'max_output_tokens' }, 'bad-response'],
      ['incomplete', { reason: 'content_filter' }, 'content-filter'],
      ['failed', null, 'other'],
    ])('%s / %o 不把部分回复当成成功', async (status, details, code) => {
      fetchMock.mockImplementation(async () => responseStream(responseFixture([outputMessage('半句话')], {
        status, incomplete_details: details,
        error: status === 'failed' ? { code: 'server_error', message: 'Failed to generate a response' } : null,
      })));
      await expect(app.aiChat(REQ)).rejects.toMatchObject({ code });
      expect(app.getCallLog().calls[0]).toMatchObject({ ok: false, error: { code } });
    });

    it('没有完成事件的断流不能执行部分工具调用;空回复、拒绝和畸形 JSON 也不算成功', async () => {
      fetchMock.mockImplementationOnce(async () => responseStream(responseFixture(), [
        { type: 'response.output_text.delta', item_id: 'msg_test', output_index: 0, content_index: 0, delta: '半句话', logprobs: [] },
        { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'country', arguments: '{}', status: 'completed' } },
      ], false));
      await expect(app.aiChat(REQ)).rejects.toMatchObject({ code: 'bad-response' });
      fetchMock.mockImplementationOnce(async () => responseStream(responseFixture([])));
      await expect(app.aiChat(REQ)).rejects.toMatchObject({ code: 'bad-response' });
      fetchMock.mockImplementationOnce(async () => responseStream(responseFixture([{ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'Cannot help with that' }] }])));
      await expect(app.aiChat(REQ)).rejects.toMatchObject({ code: 'content-filter' });
      fetchMock.mockImplementationOnce(async () => new Response('data: {broken\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
      await expect(app.aiChat(REQ)).rejects.toMatchObject({ code: 'bad-response' });
    });

    it.each([
      [401, 'invalid_api_key', 'auth'],
      [429, 'insufficient_quota', 'quota'],
      [429, 'rate_limit_exceeded', 'rate-limit'],
    ])('HTTP %i / %s 的错误类型保留,API 密钥不进错误记录', async (status, code, expected) => {
      fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: { message: `Rejected ${KEY}`, code, type: code, param: null } }), { status }));
      await expect(app.aiChat(REQ)).rejects.toMatchObject({ code: expected });
      expect(app.getCallLog().calls[0]).toMatchObject({ ok: false, error: { code: expected } });
      expect(JSON.stringify(app.getCallLog().calls)).not.toContain(KEY);
    });

    it.each([['insufficient_quota', 'quota'], ['rate_limit_exceeded', 'rate-limit']])('HTTP 200 里的流式 %s 不能当成成功', async (code, expected) => {
      fetchMock.mockImplementation(async () => responseStream(responseFixture(), [{ type: 'error', code, message: `Rejected ${KEY}`, param: null }], false));
      await expect(app.aiChat(REQ)).rejects.toMatchObject({ code: expected });
      expect(JSON.stringify(app.getCallLog().calls)).not.toContain(KEY);
    });

    it('主动取消不联网;断网和无响应超时都报告 network', async () => {
      const ac = new AbortController();
      ac.abort();
      await expect(app.aiChat(REQ, { signal: ac.signal })).rejects.toMatchObject({ code: 'aborted' });
      expect(fetchMock).not.toHaveBeenCalled();
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await expect(app.aiChat(REQ)).rejects.toMatchObject({ code: 'network' });
      vi.useFakeTimers();
      fetchMock.mockImplementation(async (_url, init) => new Response(new ReadableStream({
        start(ctl) { init?.signal?.addEventListener('abort', () => ctl.error(new DOMException('aborted', 'AbortError'))); },
      }), { headers: { 'Content-Type': 'text/event-stream' } }));
      const waiting = app.aiChat(REQ).catch((e) => e);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(await waiting).toMatchObject({ code: 'network', message: expect.stringContaining('没有回应') });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('旧设置继续使用原服务商,切换 OpenAI 后使用默认模型,不挪用旧密钥', async () => {
    storage.setItem('civ-atlas:ai-settings', JSON.stringify({ provider: 'deepseek', deepseek: { model: 'deepseek-chat', thinking: false }, openai: { model: 123 } }));
    storage.setItem('civ-atlas:ai-secrets', JSON.stringify({ deepseek: 'old-deepseek-key' }));
    app = await loadApp();
    await app.aiChat(REQ);
    expect(request().url).toBe('https://api.deepseek.com/chat/completions');
    expect(request().headers.get('authorization')).toBe('Bearer old-deepseek-key');
    expect(request().body.model).toBe('deepseek-chat');
    app.chooseProvider('openai');
    await expect(app.aiChat(REQ)).rejects.toMatchObject({ code: 'not-configured' });
    app.setSecret('openai', KEY);
    await app.aiChat(REQ);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(request(1).url).toBe('https://api.openai.com/v1/responses');
    expect(request(1).body.model).toBe('gpt-6.1-terra');
    expect(request(1).headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });
});
