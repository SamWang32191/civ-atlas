/**
 * 问题记录(「更多」菜单里):最近 7 天出错、意外关闭、AI 调用和助手用工具的次数,下面一条条列出出过的问题(新的在前)。
 * 「导出…」先把要导出的全文给用户看,再复制或下载;记录本身在 src/diag(只存在这个浏览器里,不会自动发出去)。
 * 样子照「键盘快捷键」一览(shortcuts.css 的 kb-*);自己的几处在 diag.css。Esc、✕ 或点外面关掉。
 *
 *   openDiag() / closeDiag()
 *   DiagHost   窗口本身,App 里一直挂着
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useAiOn } from '../ai/client';
import { GENERATOR_VERSION } from '../gen/edits';
import {
  MAX_ENTRIES,
  clearDiag,
  exportDiagJson,
  isProblem,
  summarize,
  useDiag,
  type DiagAiEntry,
  type DiagCrashEntry,
  type DiagEntry,
  type DiagEnv,
  type DiagErrorEntry,
  type DiagToolEntry,
} from '../diag/log';
import { copyText } from './clipboard';
import { BETA_SITE, OLD_SITE } from './oldSite';
import { APP_VERSION } from './version';
import './shortcuts.css';
import './diag.css';

let open = false;
const subs = new Set<() => void>();
const set = (v: boolean) => {
  if (v === open) return;
  open = v;
  subs.forEach((f) => f());
};
export const openDiag = () => set(true);
export const closeDiag = () => set(false);

export function DiagHost() {
  const on = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => open,
    () => false,
  );
  return on ? <DiagDialog /> : null;
}

/** 界面上最多列多少条问题(导出里全有) */
const LIST_MAX = 50;
/** 「已复制」显示多久 */
const COPIED_MS = 2000;

const PROVIDER: Record<string, string> = { none: '未设置', official: '我们的 AI', openai: 'OpenAI', deepseek: 'DeepSeek', bailian: '阿里云百炼', mock: '测试用假 AI' };
const AI_ERR: Record<string, string> = {
  auth: '密钥不对或登录过期',
  quota: '余额或积分不够',
  'rate-limit': '调用太频繁',
  network: '网络不通',
  'bad-response': '回的东西看不懂',
  'content-filter': '被服务商的内容审核拦下',
  other: '其他错误',
};
/** 助手的工具(src/ai/agent/assistant.ts)的说法 */
const TOOL: Record<string, string> = {
  country: '查国家',
  chronicle: '查编年史',
  situation: '看局势',
  try_edits: '试推演',
  propose_edits: '列确认单',
  /** 模型写了一个没有的工具(名字不记) */
  '?': '不认识的工具',
};
const TOOL_WHY: Record<string, string> = { 'no-tool': '没有这个工具', 'bad-args': '参数不是合法的 JSON', failed: '执行时出错' };

const pad = (n: number) => String(n).padStart(2, '0');
/** 10月17日 20:41(不是今年的带年份) */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${y}${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const secs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} 毫秒` : `${Math.round(ms / 1000)} 秒`);
const minutes = (ms: number) => (ms < 60_000 ? '不到 1 分钟' : `${Math.round(ms / 60_000)} 分钟`);
const doingText = (doing?: string, year?: number) => (doing ? `${doing.replace(/^AI:/, 'AI ')}${year !== undefined ? `（第 ${year} 年）` : ''}` : '');

/** 一条问题:标题 + 一句话 */
export function problemText(e: DiagEntry): { title: string; line: string } {
  if (e.kind === 'crash') {
    const c = e as DiagCrashEntry;
    const doing = doingText(c.doing, c.year);
    const long = minutes(Date.parse(c.at) - Date.parse(c.started));
    return { title: '意外关闭', line: `${doing ? `当时在${doing}，` : ''}网页开在前台，开了 ${long}` };
  }
  if (e.kind === 'error') {
    const x = e as DiagErrorEntry;
    const doing = doingText(x.doing);
    const where = x.src === 'worker' ? '' : doing ? `${doing}时：` : '';
    return { title: '页面出错', line: `${where}${x.message}${x.n && x.n > 1 ? `（连着出了 ${x.n} 次）` : ''}` };
  }
  if (e.kind === 'ai') {
    const a = e as DiagAiEntry;
    // 网络错误里等了很久的多半是超时:"等了 60 秒没回"
    const why = a.code === 'network' && a.ms >= 20_000 ? `等了 ${secs(a.ms)}没回` : `${AI_ERR[a.code ?? 'other'] ?? AI_ERR.other}（${secs(a.ms)}）`;
    return { title: 'AI 调用失败', line: [a.feature, PROVIDER[a.provider] ?? a.provider, why].join('，') };
  }
  if (e.kind === 'tool') {
    const t = e as DiagToolEntry;
    return { title: '助手用工具失败', line: `${TOOL[t.tool] ?? t.tool}：${TOOL_WHY[t.why ?? 'failed']}` };
  }
  return { title: e.kind, line: '' };
}

/** 导出文件开头那些:版本、哪个网站、设备 */
function diagEnv(): DiagEnv {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    version: APP_VERSION,
    generator: GENERATOR_VERSION,
    site: OLD_SITE ? `旧版网站 v${OLD_SITE}` : BETA_SITE ? '测试网站' : '正式网站',
    device: {
      browser: nav.userAgent,
      screen: `${screen.width}×${screen.height} @${Math.round(devicePixelRatio * 100) / 100}x`,
      window: `${innerWidth}×${innerHeight}`,
      cores: nav.hardwareConcurrency ?? null,
      memoryGB: nav.deviceMemory ?? null,
      language: nav.language,
    },
  };
}

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const kb = (n: number) => (n < 1024 ? `${n} 字节` : `${Math.max(1, Math.round(n / 1024))} KB`);

function DiagDialog() {
  const { entries } = useDiag();
  const ai = useAiOn();
  const [page, setPage] = useState<'list' | 'export'>('list');
  /** 导出页的全文:点「导出…」那一刻定下来(看的和存的是同一份) */
  const [text, setText] = useState('');
  const [armClear, setArmClear] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeDiag();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  useEffect(() => {
    if (!armClear) return;
    const t = setTimeout(() => setArmClear(false), 4000);
    return () => clearTimeout(t);
  }, [armClear]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);

  const s = summarize(entries);
  const problems = entries.filter((e) => isProblem(e) && (ai || (e.kind !== 'ai' && e.kind !== 'tool')));
  const shown = problems.slice(0, LIST_MAX);
  const stamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  };
  // 挂在 body 下:深浅色跟着页面(实景、高程等图层是深色)
  const theme = document.querySelector('.app')?.getAttribute('data-theme') ?? undefined;

  const body =
    page === 'export' ? (
      <>
        <header className="kb-head">
          <button className="dg-back" data-act="diag-back" onClick={() => setPage('list')}>
            ‹ 问题记录
          </button>
          <button className="kb-x" data-act="diag-close" onClick={closeDiag} aria-label="关闭">
            ✕
          </button>
        </header>
        <p className="dg-note">下面就是要导出的全部内容。里面没有密钥、AI 写的字和你写的文字；有浏览器型号、屏幕大小和种子，方便我们照着重现。</p>
        <pre className="dg-pre" data-testid="diag-export">
          {text}
        </pre>
        <div className="dg-foot">
          <small>
            共 {entries.length} 条，约 {kb(new Blob([text]).size)}
          </small>
          <span className="dg-grow" />
          <button className="ai-mini" data-act="diag-cancel" onClick={() => setPage('list')}>
            取消
          </button>
          <button className="ai-mini" data-act="diag-copy" onClick={() => void copyText(text).then((ok) => setCopied(ok))}>
            {copied ? '已复制' : '复制'}
          </button>
          <button className="ai-mini primary" data-act="diag-download" onClick={() => download(text, `文明与地图-问题记录-${stamp()}.json`)}>
            下载文件
          </button>
        </div>
      </>
    ) : (
      <>
        <header className="kb-head">
          <h2>问题记录</h2>
          <button className="kb-x" data-act="diag-close" onClick={closeDiag} aria-label="关闭">
            ✕
          </button>
        </header>
        <p className="dg-note">
          记下这台设备上页面出错、意外关闭{ai ? '和 AI 调用' : ''}的情况，只存在这个浏览器里，不会自动发出去。遇到问题时点「导出」，把文件发到交流群，方便我们排查。
        </p>
        {entries.length ? (
          <>
            <h3 className="kb-sec">最近 7 天</h3>
            <div className="kb-group">
              <Count label="页面出错" text={`${s.errors} 次`} />
              <Count label="意外关闭" text={`${s.crashes} 次`} />
              {ai && <Count label="AI 调用" text={s.ai.total ? `${s.ai.total} 次，成功 ${s.ai.ok} 次` : '0 次'} />}
              {ai && <Count label="助手用工具" text={s.tools.total ? `${s.tools.total} 次，成功 ${s.tools.ok} 次` : '0 次'} />}
            </div>
            <h3 className="kb-sec">出的问题</h3>
            <div className="kb-group">
              {shown.length ? (
                shown.map((e, i) => {
                  const t = problemText(e);
                  return (
                    <div className="dg-row" key={`${e.at}-${i}`} data-kind={e.kind}>
                      <div className="dg-l1">
                        <b>{t.title}</b>
                        <time dateTime={e.at}>{when(e.at)}</time>
                      </div>
                      {t.line && <div className="dg-l2">{t.line}</div>}
                    </div>
                  );
                })
              ) : (
                <div className="dg-empty">没有出过问题</div>
              )}
            </div>
            {problems.length > LIST_MAX && <p className="dg-more">还有 {problems.length - LIST_MAX} 条更早的，导出里都有</p>}
            {ai && <p className="dg-more">AI 每一次发了什么、回了什么，在「AI 设置 → 调用记录」里看</p>}
          </>
        ) : (
          <>
            <h3 className="kb-sec">记录</h3>
            <div className="kb-group">
              <div className="dg-empty">还没有记录</div>
            </div>
          </>
        )}
        <div className="dg-foot">
          {entries.length > 0 && <small>最多留最近 {MAX_ENTRIES} 条</small>}
          <span className="dg-grow" />
          <button
            className={`ai-mini${armClear ? ' danger' : ''}`}
            data-act="diag-clear"
            disabled={!entries.length}
            onClick={() => {
              if (!armClear) return setArmClear(true);
              setArmClear(false);
              clearDiag();
            }}
            onBlur={() => setArmClear(false)}
          >
            {armClear ? '再点一次清空' : '清空'}
          </button>
          <button
            className="ai-mini primary"
            data-act="diag-export"
            disabled={!entries.length}
            onClick={async () => {
              const env = diagEnv();
              // 浏览器存储用了多少(存不下也会出怪事);问不到就不写
              try {
                const est = await navigator.storage?.estimate?.();
                if (est?.usage !== undefined) env.device.storageMB = Math.round(est.usage / 1048576);
              } catch {
                // 不写
              }
              setText(exportDiagJson(env, entries));
              setPage('export');
            }}
          >
            导出…
          </button>
        </div>
      </>
    );

  return createPortal(
    <div className="kb-bg" data-theme={theme} onPointerDown={(e) => e.target === e.currentTarget && closeDiag()}>
      <section className="kb-panel dg-panel" role="dialog" aria-modal="true" aria-label="问题记录" data-testid="diag" onWheel={(e) => e.stopPropagation()}>
        {body}
      </section>
    </div>,
    document.body,
  );
}

function Count({ label, text }: { label: string; text: string }) {
  return (
    <div className="kb-row">
      <span>{label}</span>
      <span className="dg-num">{text}</span>
    </div>
  );
}
