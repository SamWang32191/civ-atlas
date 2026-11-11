/** OpenAI 可选模型;设置、界面和请求参数共用,避免显示的模型与实际调用不一致。 */
export const OPENAI_MODELS = [
  { id: 'gpt-6.1-sol', note: '复杂任务', reasoningEffort: 'low' },
  { id: 'gpt-6.1-terra', note: '默认模型(推荐)', reasoningEffort: 'none' },
  { id: 'gpt-6-astra', note: '更强,也更贵', reasoningEffort: 'low' },
] satisfies { id: string; note: string; reasoningEffort: 'none' | 'low' }[];

export const DEFAULT_OPENAI_MODEL = 'gpt-6.1-terra';

/** 旧版本的模型或不合法的设置回到默认值;不留下选单里看不到的实际模型。 */
export function openaiModel(model: string) {
  return OPENAI_MODELS.find((m) => m.id === model) ?? OPENAI_MODELS.find((m) => m.id === DEFAULT_OPENAI_MODEL)!;
}
