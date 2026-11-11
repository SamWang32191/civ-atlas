/**
 * OpenAI API:用户自己的密钥,浏览器直接调用,费用由 OpenAI 计费。
 * GPT-6.1 Terra 走 Responses API(工具调用不支持 Chat Completions),其他模型沿用 Chat Completions。
 * GPT-6.1 Terra / GPT-5.4 系列关闭推理,避免起名等短回复的 token 预算被推理占满。
 * 手填其他模型时使用该模型默认的推理设置;Chat Completions 仅 GPT-4 系传 temperature。
 * 文档:https://developers.openai.com/api/docs/models/gpt-6.1-terra
 *      https://developers.openai.com/api/docs/guides/migrate-to-responses
 */
import type { AiProvider } from '../client';
import { getAiSettings, getSecrets } from '../settings';
import { AiError } from '../types';
import { compatChat, type CompatConfig } from './compat';
import { responsesChat } from './responses';

export const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export const OPENAI_MODELS = [
  { id: 'gpt-6.1-terra', note: '默认模型(推荐)' },
  { id: 'gpt-5.4-mini', note: '速度与效果均衡' },
  { id: 'gpt-5.4', note: '更强,也更贵' },
];

export const openaiProvider: AiProvider = {
  kind: 'openai',
  label: 'OpenAI',
  status() {
    const { model } = getAiSettings().openai;
    if (!getSecrets().openai) return { ready: false, model, reason: '还没填 OpenAI 的 API 密钥:到"AI"设置里填上' };
    return { ready: true, model };
  },
  async chat(req, opts) {
    const { model } = getAiSettings().openai;
    const key = getSecrets().openai;
    if (!key) throw new AiError('not-configured', '还没填 OpenAI 的 API 密钥:到"AI"设置里填上');
    // 只对已知支持 none 的 GPT-5.4 系列及其日期快照关闭推理,不猜其他模型的能力。
    const noReasoning = /^gpt-5\.4(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
    const terra = /^gpt-6\.1-terra(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
    const cfg: CompatConfig = {
      name: 'OpenAI',
      url: terra ? OPENAI_RESPONSES_URL : OPENAI_URL,
      key,
      model,
      maxTokensField: 'max_completion_tokens',
      extra: noReasoning ? { reasoning_effort: 'none' } : undefined,
      mapError: (e) => e.code === 'insufficient_quota'
        ? new AiError('quota', 'OpenAI API 额度不足:请到 OpenAI 平台检查余额和用量限额;ChatGPT 订阅不包含 API 额度')
        : null,
    };
    if (terra) return responsesChat(cfg, req, opts);
    return compatChat(
      cfg,
      { ...req, temperature: /^gpt-4(?:[.-]|$)/.test(model) ? req.temperature : undefined },
      opts,
    );
  },
};
