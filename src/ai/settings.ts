/**
 * AI 设置与密钥的本地存储(阶段 5)。只存在用户自己的浏览器里,不上传。
 *
 *   设置(用不用 AI、用哪家、模型、地域、深度思考、记不记密钥)→ localStorage 'civ-atlas:ai-settings'
 *   密钥(OpenAI / DeepSeek / 百炼的 API 密钥、我们 AI 的登录令牌)→
 *       "记住密钥"开着:localStorage 'civ-atlas:ai-secrets'(下次打开还在)
 *       关着:只在内存里(这次打开的页面有效,刷新 / 关掉就忘),同时把存过的删掉
 *
 * 浏览器存储不可用(隐私模式)时一律只在内存里。
 * 规矩:密钥不进网址、不进调用记录、不打印到控制台。
 */
import { useSyncExternalStore } from 'react';
import { notifyAiChanged, setActiveProvider, setAiOn } from './client';
import type { AiProviderKind } from './types';

export type BailianRegion = 'cn' | 'intl';

export interface AiSettings {
  /** 「使用 AI 功能」:关掉 = 界面上所有 AI 入口都不显示(只管这个浏览器;写过的史书、名字由来不删) */
  enabled: boolean;
  /** 用哪家;null = 还没选 */
  provider: AiProviderKind | null;
  /** 在这个浏览器里记住密钥和登录 */
  remember: boolean;
  openai: { model: string };
  deepseek: { model: string; thinking: boolean };
  bailian: { model: string; region: BailianRegion; thinking: boolean };
}

/** 存密钥的格子:各家的 API 密钥 + 我们的 AI 的登录令牌 */
export interface AiSecrets {
  openai?: string;
  deepseek?: string;
  bailian?: string;
  official?: { token: string; account?: string };
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: true,
  provider: null,
  remember: true,
  openai: { model: 'gpt-6.1-terra' },
  deepseek: { model: 'deepseek-flash', thinking: false },
  bailian: { model: 'qwen-plus', region: 'cn', thinking: false },
};

const SETTINGS_KEY = 'civ-atlas:ai-settings';
const SECRETS_KEY = 'civ-atlas:ai-secrets';
const KINDS: AiProviderKind[] = ['official', 'openai', 'deepseek', 'bailian', 'mock'];

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readJson(key: string): unknown {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, v: unknown | null) {
  try {
    const s = storage();
    if (!s) return;
    if (v === null) s.removeItem(key);
    else s.setItem(key, JSON.stringify(v));
  } catch {
    /* 存不下 / 隐私模式:只留在内存里 */
  }
}

const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** 读存档里的设置,坏的字段用默认值 */
export function sanitizeSettings(v: unknown): AiSettings {
  const d = DEFAULT_AI_SETTINGS;
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, any>;
  const oa = (o.openai && typeof o.openai === 'object' ? o.openai : {}) as Record<string, unknown>;
  const ds = (o.deepseek && typeof o.deepseek === 'object' ? o.deepseek : {}) as Record<string, unknown>;
  const bl = (o.bailian && typeof o.bailian === 'object' ? o.bailian : {}) as Record<string, unknown>;
  return {
    enabled: bool(o.enabled, d.enabled),
    provider: KINDS.includes(o.provider) ? o.provider : null,
    remember: bool(o.remember, d.remember),
    openai: { model: str(oa.model, d.openai.model) },
    deepseek: { model: str(ds.model, d.deepseek.model), thinking: bool(ds.thinking, d.deepseek.thinking) },
    bailian: {
      model: str(bl.model, d.bailian.model),
      region: bl.region === 'intl' ? 'intl' : 'cn',
      thinking: bool(bl.thinking, d.bailian.thinking),
    },
  };
}

function sanitizeSecrets(v: unknown): AiSecrets {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, any>;
  const out: AiSecrets = {};
  if (typeof o.openai === 'string' && o.openai) out.openai = o.openai;
  if (typeof o.deepseek === 'string' && o.deepseek) out.deepseek = o.deepseek;
  if (typeof o.bailian === 'string' && o.bailian) out.bailian = o.bailian;
  if (o.official && typeof o.official.token === 'string' && o.official.token) {
    out.official = { token: o.official.token, account: typeof o.official.account === 'string' ? o.official.account : undefined };
  }
  return out;
}

let settings: AiSettings | null = null;
let secrets: AiSecrets | null = null;
const subs = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  for (const f of subs) f();
  notifyAiChanged();
};

function load() {
  if (settings && secrets) return;
  settings = sanitizeSettings(readJson(SETTINGS_KEY));
  secrets = settings.remember ? sanitizeSecrets(readJson(SECRETS_KEY)) : {};
  setAiOn(settings.enabled);
}

export function getAiSettings(): AiSettings {
  load();
  return settings!;
}

export function updateAiSettings(patch: Partial<Omit<AiSettings, 'openai' | 'deepseek' | 'bailian'>> & {
  openai?: Partial<AiSettings['openai']>;
  deepseek?: Partial<AiSettings['deepseek']>;
  bailian?: Partial<AiSettings['bailian']>;
}): void {
  const cur = getAiSettings();
  settings = sanitizeSettings({
    ...cur,
    ...patch,
    openai: { ...cur.openai, ...patch.openai },
    deepseek: { ...cur.deepseek, ...patch.deepseek },
    bailian: { ...cur.bailian, ...patch.bailian },
  });
  writeJson(SETTINGS_KEY, settings);
  setAiOn(settings.enabled);
  if (patch.remember !== undefined) writeJson(SECRETS_KEY, settings.remember && hasAny(secrets!) ? secrets : null);
  emit();
}

const hasAny = (s: AiSecrets) => !!(s.openai || s.deepseek || s.bailian || s.official);

export function getSecrets(): Readonly<AiSecrets> {
  load();
  return secrets!;
}

/** 粘贴进来的密钥去掉空白和误带的 "Bearer " */
export function cleanKey(k: string): string {
  return k.replace(/^\s*bearer\s+/i, '').replace(/\s+/g, '');
}

export function setSecret<K extends keyof AiSecrets>(slot: K, value: AiSecrets[K] | undefined): void {
  load();
  const next = { ...secrets! };
  if (value === undefined || value === '') delete next[slot];
  else next[slot] = value;
  secrets = next;
  writeJson(SECRETS_KEY, settings!.remember && hasAny(next) ? next : null);
  emit();
}

/** 选用哪家(设置面板的单选);立刻生效 */
export function chooseProvider(kind: AiProviderKind | null): void {
  updateAiSettings({ provider: kind });
  setActiveProvider(kind);
}

/** 「使用 AI 功能」开 / 关 */
export function setAiEnabled(on: boolean): void {
  updateAiSettings({ enabled: on });
}

/** React:设置或密钥变了就重渲染 */
export function useAiSettingsVersion(): number {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
    () => version,
  );
}

/** 单测用:忘掉内存里的,下次从存储重读 */
export function resetAiSettingsForTest(): void {
  settings = null;
  secrets = null;
}

/** 把一段文字里出现的密钥遮掉(服务商的报错偶尔会原样带回密钥) */
export function scrubSecrets(text: string): string {
  let out = text;
  const s = secrets ?? {};
  for (const k of [s.openai, s.deepseek, s.bailian, s.official?.token]) {
    if (k && k.length >= 6) out = out.split(k).join('***');
  }
  return out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***');
}
