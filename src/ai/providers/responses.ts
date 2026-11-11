/**
 * OpenAI Responses API:GPT-6.1 Terra 的工具调用必须走这里。
 * 关闭推理、store:false,每轮由本地传完整对话,不使用 previous_response_id。
 * 流中只把 output_text.delta 交给界面;完整文本和工具参数以 response.completed.output 为准,
 * 不把未完成的工具调用交给助手执行。没有完成事件的断流一律报错。
 * https://developers.openai.com/api/docs/guides/migrate-to-responses
 * https://developers.openai.com/api/reference/resources/responses/streaming-events
 */
import { idleTimer, readSse } from '../sse';
import { AiError, type AiCallOptions, type AiRequest, type AiResult, type AiToolCall } from '../types';
import { errorInfo, mapHttpError, withJsonHint, type CompatConfig } from './compat';

type Config = Pick<CompatConfig, 'name' | 'url' | 'key' | 'model' | 'mapError' | 'idleMs'>;

function requestBody(model: string, req: AiRequest): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  for (const m of req.json ? withJsonHint(req.messages) : req.messages) {
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId ?? '', output: m.content });
    } else if (m.role === 'assistant' && m.toolCalls?.length) {
      if (m.content) input.push({ role: 'assistant', content: m.content });
      for (const c of m.toolCalls) input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.args });
    } else {
      input.push({ role: m.role, content: m.content });
    }
  }
  const body: Record<string, unknown> = { model, input, stream: true, store: false, reasoning: { effort: 'none' } };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_output_tokens = req.maxTokens;
  if (req.json) body.text = { format: { type: 'json_object' } };
  if (req.tools?.length) {
    // Responses 默认尝试 strict;现有工具的可选参数不能被改成必填。
    body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
    if (req.toolChoice) body.tool_choice = req.toolChoice;
  }
  return body;
}

export async function responsesChat(cfg: Config, req: AiRequest, opts: AiCallOptions): Promise<Omit<AiResult, 'provider' | 'ms'>> {
  if (opts.signal?.aborted) throw new AiError('aborted', '已取消');
  const idle = idleTimer(opts.signal, cfg.idleMs ?? 90_000);
  const bad = () => new AiError('bad-response', `${cfg.name} 返回的内容不完整或看不懂,请再试一次`);
  const httpError = (status: number, body: string) => {
    const info = errorInfo(status, body);
    // 流里的错误没有 HTTP 429,仍要区分限流和额度不足。
    if (info.code === 'rate_limit_exceeded') info.status = 429;
    return cfg.mapError?.(info) ?? mapHttpError(cfg.name, info, cfg.model);
  };
  const parse = (raw: string): any => {
    try { return JSON.parse(raw); } catch { throw bad(); }
  };

  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(requestBody(cfg.model, req)),
      signal: idle.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    idle.arm();
    if (!res.ok) throw httpError(res.status, await res.text());

    let final: any;
    let streamed = '';
    if (/application\/json/i.test(res.headers.get('content-type') ?? '')) {
      final = parse(await res.text());
    } else {
      if (!res.body) throw bad();
      for await (const ev of readSse(res.body, idle.arm)) {
        const e = parse(ev.data);
        if (e?.type === 'error') throw httpError(e.status ?? 500, JSON.stringify({ error: e }));
        if (e?.type === 'response.output_text.delta' && typeof e.delta === 'string') {
          streamed += e.delta;
          opts.onDelta?.(e.delta, streamed);
        }
        if (['response.completed', 'response.failed', 'response.incomplete'].includes(e?.type)) {
          final = e.response;
          break;
        }
      }
    }
    if (!final || typeof final !== 'object') throw bad();
    if (final.error) throw httpError(500, JSON.stringify({ error: final.error }));
    if (final.status === 'incomplete') {
      if (final.incomplete_details?.reason === 'content_filter') throw new AiError('content-filter', `${cfg.name} 的内容安全审核拦下了这次回复,换个说法再试`);
      throw new AiError('bad-response', `${cfg.name} 没有完成这次回复,可能到了长度上限,请缩短内容再试`);
    }
    if (final.status !== 'completed' || !Array.isArray(final.output)) throw bad();

    let text = '';
    const toolCalls: AiToolCall[] = [];
    for (const item of final.output) {
      if (item?.type === 'message') {
        if (!Array.isArray(item.content)) throw bad();
        for (const part of item.content) {
          if (part?.type === 'refusal') throw new AiError('content-filter', `${cfg.name} 拒绝了这次请求,换个说法再试`);
          if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
        }
      } else if (item?.type === 'function_call') {
        if (!item.call_id || !item.name || typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string' || (item.status && item.status !== 'completed')) throw bad();
        toolCalls.push({ id: item.call_id, name: item.name, args: item.arguments });
      }
    }
    // 交回工具结果之后,模型可正常收尾不说话;其余空回复不能当成成功。
    if (!text && !toolCalls.length && !(req.tools?.length && req.messages.some((m) => m.role === 'tool'))) throw bad();
    if (text.startsWith(streamed) && text.length > streamed.length) opts.onDelta?.(text.slice(streamed.length), text);
    const u = final.usage;
    const usage = u && Number.isFinite(u.input_tokens) && Number.isFinite(u.output_tokens)
      ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens }
      : undefined;
    return { text, ...(toolCalls.length ? { toolCalls } : {}), model: typeof final.model === 'string' && final.model ? final.model : cfg.model, usage };
  } catch (e) {
    if (opts.signal?.aborted) throw new AiError('aborted', '已取消');
    if (idle.timedOut()) throw new AiError('network', `${cfg.name} 很久没有回应,请检查网络或稍后再试`);
    if (e instanceof AiError) throw e;
    throw new AiError('network', `和 ${cfg.name} 的连接失败或中途断了,请检查网络后再试`);
  } finally {
    idle.dispose();
  }
}
