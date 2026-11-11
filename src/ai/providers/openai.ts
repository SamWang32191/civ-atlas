/**
 * OpenAI API:用户自己的密钥,浏览器直接调用,费用由 OpenAI 计费。
 * 三个可选模型的工具调用都走 Responses API。Terra 关闭推理;Sol / Astra 不支持 none,使用 low。
 * https://developers.openai.com/api/docs/models/gpt-6.1-sol
 * https://developers.openai.com/api/docs/models/gpt-6.1-terra
 * https://developers.openai.com/api/docs/models/gpt-6-astra
 */
import type { AiProvider } from '../client';
import { getAiSettings, getSecrets } from '../settings';
import { AiError } from '../types';
import { openaiModel } from './openaiModels';
import { responsesChat } from './responses';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

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
    return responsesChat({
      name: 'OpenAI',
      url: OPENAI_RESPONSES_URL,
      key,
      model,
      reasoningEffort: openaiModel(model).reasoningEffort,
      mapError: (e) => e.code === 'insufficient_quota'
        ? new AiError('quota', 'OpenAI API 额度不足:请到 OpenAI 平台检查余额和用量限额;ChatGPT 订阅不包含 API 额度')
        : null,
    }, req, opts);
  },
};
