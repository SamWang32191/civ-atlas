/**
 * 启动时把 AI 接入层接上(App 里调一次):登记服务商、恢复上次选的那家、调用记录改存本地、问服务器开没开我们的 AI、查一下积分余额。
 * 问不到的话,打开账号窗、AI 设置时再问。
 */
import { registerProvider, setActiveProvider } from './client';
import { initCallLog } from './callLog';
import { getAiSettings } from './settings';
import { openaiProvider } from './providers/openai';
import { deepseekProvider } from './providers/deepseek';
import { bailianProvider } from './providers/bailian';
import { officialProvider, refreshOfficialAccount } from './providers/official';

let done = false;

/** 测试用假 AI 能不能在设置里选:开发时、或网址带 ai=mock 时 */
export function mockSelectable(): boolean {
  if (import.meta.env?.DEV) return true;
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('ai') === 'mock';
}

export function setupAi(): void {
  if (done) return;
  done = true;
  registerProvider(officialProvider);
  registerProvider(openaiProvider);
  registerProvider(deepseekProvider);
  registerProvider(bailianProvider);
  const saved = getAiSettings().provider;
  setActiveProvider(saved === 'mock' && !mockSelectable() ? null : saved);
  void initCallLog();
  void refreshOfficialAccount();
}
