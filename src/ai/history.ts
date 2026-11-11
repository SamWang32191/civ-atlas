/**
 * AI 写史书(阶段 5):按选项整理材料(prompts/history.ts)→ 经 aiChat 一章一章地写 → 存进本地的 AI 笔记
 * (library.ts,kind = "史书",按世界存)。界面(ui/HistoryBook.tsx)只管显示和按钮;这里不碰 DOM,单测用假 AI 跑完整流程。
 *
 * - 同一个"写什么 + 文体 + 篇幅"= 同一部史书(笔记的键见 historyNoteKey):重写不覆盖,新写的算这一部的又一版,
 *   最多留 BOOK_VERSIONS_MAX 版(再写就去掉最早的那版);写完才存,停下 / 出错不动旧的
 *   (分章写到一半出错时,写好的几章由调用方留在内存里,重试交回 written 从断的那章接着写)
 * - 几版存在同一条笔记里:正在用的那版(阅读页最后停在的、新写完的)放在外层(text、createdAt、book……),别的几版放在 others,
 *   ver 记正在用的是第几版。只有一版的(以前写的)没有 others、ver,照旧读;不认得 others 的地方照旧当一部书读外层那版
 * - 笔记里除了正文,还记着 book(HistoryBookMeta):写什么(国家按稳定键记)、文体、篇幅、书名、历史指纹……
 *   (AiNote 的扩展字段;library.ts 原样存取整个对象)
 * - 历史指纹对不上(改名 / 干预 / 改地形重推之后)= 旧史书"写于历史改变之前,可能对不上"
 */
import type { Civ } from '../gen/civ/types';
import { aiChat } from './client';
import { AiError, type AiProviderKind } from './types';
import { deleteNote, getNote, listNotes, notesBehind, putNote, type AiNote } from './library';
import { fixRealWords } from './realWords';
import { HISTORY_LENGTHS, HISTORY_STYLES, historyMessages, type HistoryLength, type HistoryStyle } from './prompts/history';
import {
  bookFingerprint,
  bookLoadScope,
  bookNoteKey,
  bookPrompts,
  bookStoreScope,
  isLifeScope,
  lifeKind,
  lifeMissing,
  type BookOptions,
  type BookScope,
  type BookStoredScope,
  type LifeSource,
  type LifeStoredScope,
} from './prompts/lives';

export const HISTORY_KIND = '史书';

/** 一部史书的"书目信息"(存在笔记的 book 字段里);列传、家传也存成一部"史书",写什么是一个人、一朝(prompts/lives.ts) */
export interface HistoryBookMeta {
  /** 书名:"世界通史" / "大昌史" / "第 1200—1500 年史" / "世祖苏珩羽传" / "衍朝苏氏家传" */
  title: string;
  /** "第 0—3000 年" */
  range: string;
  scope: BookStoredScope;
  style: HistoryStyle;
  length: HistoryLength;
  /** 写的时候的历史指纹 */
  fp: string;
  /** 世界种子(导出时写进说明) */
  seed: number;
  /** 分几次写的 */
  calls: number;
}

export interface HistoryNote extends AiNote {
  book: HistoryBookMeta;
  /** 这一部的别的几版(按写的先后,不含正在用的这一版);只有一版 = 没有 */
  others?: BookVersion[];
  /** 正在用的这一版是第几版(1 起,按写的先后);只有一版 = 没有 */
  ver?: number;
}

/** 一部书的一版:正文、谁写的、什么时候写的,连同写的时候的书目信息(历史指纹各版各记各的) */
export interface BookVersion {
  text: string;
  createdAt: string;
  provider: string;
  model: string;
  book: HistoryBookMeta;
}

/** 一部书最多留几版:再写一版就去掉最早的那版 */
export const BOOK_VERSIONS_MAX = 3;

const STYLES = Object.keys(HISTORY_STYLES);
const LENGTHS = Object.keys(HISTORY_LENGTHS);

function validScope(s: unknown): s is BookStoredScope {
  const x = s as BookStoredScope | null;
  if (!x || typeof x !== 'object') return false;
  if (x.kind === 'world') return true;
  if (x.kind === 'polity' || x.kind === 'person') return typeof x.key === 'string' && typeof x.name === 'string';
  if (x.kind === 'era') return Number.isFinite(x.from) && Number.isFinite(x.to);
  if (x.kind === 'character') return Number.isFinite(x.id) && Number.isFinite(x.born) && typeof x.name === 'string';
  if (x.kind === 'house') return typeof x.key === 'string' && Number.isFinite(x.dynasty) && typeof x.name === 'string';
  return false;
}

function validBook(b: unknown): b is HistoryBookMeta {
  const x = b as HistoryBookMeta | null;
  if (!x || typeof x !== 'object' || typeof x.title !== 'string' || typeof x.fp !== 'string') return false;
  return STYLES.includes(x.style) && LENGTHS.includes(x.length) && validScope(x.scope);
}

/** 笔记 → 史书(不是史书、字段坏了 = null) */
export function asHistoryNote(n: AiNote | undefined | null): HistoryNote | null {
  if (!n || n.kind !== HISTORY_KIND) return null;
  if (!validBook((n as Partial<HistoryNote>).book)) return null;
  return n as HistoryNote;
}

/**
 * 一部书的几版(按写的先后,第 1 版在前)和正在用的是哪一版(下标)。
 * 以前写的只有一版;别的几版里坏了的(文件、同步带来的)跳过,书目信息坏了的用正在用的那版的
 */
export function bookVersions(n: HistoryNote): { list: BookVersion[]; at: number } {
  const cur: BookVersion = { text: n.text, createdAt: n.createdAt, provider: n.provider, model: n.model, book: n.book };
  const others: BookVersion[] = Array.isArray(n.others)
    ? n.others
        .filter((v) => v && typeof v.text === 'string' && typeof v.createdAt === 'string')
        .map((v) => ({
          text: v.text,
          createdAt: v.createdAt,
          provider: typeof v.provider === 'string' ? v.provider : '',
          model: typeof v.model === 'string' ? v.model : '',
          book: validBook(v.book) ? v.book : n.book,
        }))
    : [];
  const ver = typeof n.ver === 'number' && Number.isInteger(n.ver) ? n.ver - 1 : others.length;
  const at = Math.max(0, Math.min(others.length, ver));
  return { list: [...others.slice(0, at), cur, ...others.slice(at)], at };
}

/** 几版拼成存的那条笔记:正在用的(下标 at)放外层,别的放 others */
export function versionsNote(key: string, list: readonly BookVersion[], at: number): HistoryNote {
  const i = Math.max(0, Math.min(list.length - 1, at));
  const v = list[i];
  const note: HistoryNote = {
    key,
    kind: HISTORY_KIND,
    title: historyNoteTitle(v.book.title, v.book.style, v.book.length, v.book.scope),
    text: v.text,
    createdAt: v.createdAt,
    provider: v.provider,
    model: v.model,
    book: v.book,
  };
  if (list.length > 1) {
    note.others = list.filter((_, k) => k !== i);
    note.ver = i + 1;
  }
  return note;
}

/** 新写的一版加在最后、成为正在用的那版;超过 BOOK_VERSIONS_MAX 版就去掉最早的 */
export function addBookVersion(prev: HistoryNote | null, key: string, v: BookVersion): HistoryNote {
  const list = prev ? bookVersions(prev).list : [];
  list.push(v);
  while (list.length > BOOK_VERSIONS_MAX) list.shift();
  return versionsNote(key, list, list.length - 1);
}

/** 阅读页翻到第 at 版(下标):记下来,下次打开、故事长图用它。返回写进浏览器没有 */
export function pickBookVersion(world: string, key: string, at: number): boolean {
  const n = asHistoryNote(getNote(world, key));
  if (!n) return true;
  const vs = bookVersions(n);
  if (at === vs.at || at < 0 || at >= vs.list.length) return true;
  return putNote(world, versionsNote(key, vs.list, at));
}

/**
 * 删掉第 at 版(下标):还剩的,正在用的换成剩下最新的那版;只剩这一版的,整部删掉。
 * 返回 'version'(删了一版)/ 'book'(整部删了)/ null(找不到)
 */
export function deleteBookVersion(world: string, key: string, at: number): 'version' | 'book' | null {
  const n = asHistoryNote(getNote(world, key));
  if (!n) return null;
  const { list } = bookVersions(n);
  if (at < 0 || at >= list.length) return null;
  if (list.length <= 1) {
    deleteNote(world, key);
    return 'book';
  }
  list.splice(at, 1);
  putNote(world, versionsNote(key, list, list.length - 1));
  return 'version';
}

/**
 * 浏览器存储满了时「删掉第 1 版再存」:去掉最早的那版,再往浏览器里写一次。正在看的不是第 1 版就还看它,是就换成最新的。
 * 返回这回写进去没有(只有一版的不删,返回 false)
 */
export function dropOldestVersion(world: string, key: string): boolean {
  const n = asHistoryNote(getNote(world, key));
  if (!n) return false;
  const { list, at } = bookVersions(n);
  if (list.length <= 1) return false;
  list.shift();
  return putNote(world, versionsNote(key, list, at > 0 ? at - 1 : list.length - 1));
}

/** 认一版用的:同一时刻、同一家 AI 写的同样长的,算同一版 */
const versionSig = (v: BookVersion) => `${v.createdAt}|${v.provider}|${v.model}|${v.text.length}`;

/**
 * 浏览器存储满了:这一部里哪几版只在页面里、没写进浏览器(第几版,1 起);都写进去了 / 浏览器本来就不让存 = 空。
 * 从不替用户删:要腾地方由用户点「删掉第 1 版再存」(dropOldestVersion)
 */
export function unsavedVersions(world: string, n: HistoryNote): number[] {
  const disk = notesBehind(world);
  if (!disk) return [];
  const old = asHistoryNote(disk.find((x) => x.key === n.key));
  const have = new Set(old ? bookVersions(old).list.map(versionSig) : []);
  return bookVersions(n).list.flatMap((v, i) => (have.has(versionSig(v)) ? [] : [i + 1]));
}

/** 最近写的那版是什么时候写的(已写列表按它排:翻看旧版不挪位置) */
function latestAt(n: HistoryNote): string {
  let t = n.createdAt;
  if (Array.isArray(n.others)) for (const v of n.others) if (v && typeof v.createdAt === 'string' && v.createdAt > t) t = v.createdAt;
  return t;
}

/** 这个世界写过的史书(最近写过的在前) */
export function listHistoryNotes(world: string): HistoryNote[] {
  return listNotes(world, HISTORY_KIND)
    .map(asHistoryNote)
    .filter((n): n is HistoryNote => !!n)
    .map((n) => [n, latestAt(n)] as const)
    .sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))
    .map(([n]) => n);
}

/**
 * 一部史书在现在的历史里:还能不能按原来的选项重写(scope)、是不是写于历史改变之前(stale)。
 * src:列传、家传的材料要界面层交进来的人物卡(prompts/lives.ts 的 LifeSource);史书用不着
 */
export function historyNoteStatus(civ: Civ, note: HistoryNote, src?: LifeSource | null): { scope: BookScope | null; stale: boolean; why?: string } {
  const s = note.book.scope;
  const scope = bookLoadScope(civ, s, src);
  if (!scope) return { scope: null, stale: true, why: isLifeScope(s) ? lifeMissing(s as LifeStoredScope) : `现在的历史里没有${s.kind === 'polity' ? s.name || '这个国家' : '这一段'}了` };
  const stale = bookFingerprint(civ, { scope, style: note.book.style, length: note.book.length }, src) !== note.book.fp;
  return { scope, stale };
}

/**
 * 每一版是不是写于历史改变之前(和 bookVersions 的顺序一样)。每版按自己记的"写什么"找、算指纹
 * (作者改过人物的生年再写一版:两版记的生年不同,旧的那版找不到 = 算,新的照样对得上;和正在用的是哪版无关)
 */
export function versionsStale(civ: Civ, note: HistoryNote, src?: LifeSource | null): boolean[] {
  const fps = new Map<string, string | null>();
  return bookVersions(note).list.map((v) => {
    const k = JSON.stringify([v.book.scope, v.book.style, v.book.length]);
    let fp = fps.get(k);
    if (fp === undefined) {
      const scope = bookLoadScope(civ, v.book.scope, src);
      fp = scope ? bookFingerprint(civ, { scope, style: v.book.style, length: v.book.length }, src) : null;
      fps.set(k, fp);
    }
    return fp === null || v.book.fp !== fp;
  });
}

/** 这一部在现在的历史里按什么重写:从最新写的那版往前,第一个还找得到的"写什么";都找不到 = null */
export function bookRedoScope(civ: Civ, note: HistoryNote, src?: LifeSource | null): BookScope | null {
  const { list } = bookVersions(note);
  for (let i = list.length - 1; i >= 0; i--) {
    const scope = bookLoadScope(civ, list[i].book.scope, src);
    if (scope) return scope;
  }
  return null;
}

/** 界面上的文体名:成书的三种叫"纪传体 / 编年体 / 白话通俗";旧版写史书面板的"史书体""传说故事"照旧 */
export function historyStyleLabel(style: HistoryStyle): string {
  return style === 'plain' ? '白话通俗' : HISTORY_STYLES[style].label;
}

/** 一部书的文体名:列传、家传的三种叫"史书体 / 白话讲述 / 传说故事",史书照 historyStyleLabel */
export function bookStyleLabel(scope: { kind: string }, style: HistoryStyle): string {
  return isLifeScope(scope) ? HISTORY_STYLES[style].label : historyStyleLabel(style);
}

/** 篇幅的说法:史书"中篇";列传、家传"约 2000 字" */
export function bookLengthLabel(scope: { kind: string }, length: HistoryLength): string {
  return isLifeScope(scope) ? `约 ${HISTORY_LENGTHS[length].chars} 字` : `${HISTORY_LENGTHS[length].label}篇`;
}

/** 一部书的写法:"纪传体，中篇";列传、家传前面多"列传""家传":"列传，史书体，约 2000 字"(sep 换成" · "就是已写列表里那行小字) */
export function bookHowText(scope: { kind: string }, style: HistoryStyle, length: HistoryLength, sep = '，'): string {
  return [isLifeScope(scope) ? lifeKind(scope) : '', bookStyleLabel(scope, style), bookLengthLabel(scope, length)].filter(Boolean).join(sep);
}

/** 笔记列表里的标题:"世界通史 · 纪传体 · 中篇" / "世祖苏珩羽传 · 列传 · 史书体 · 约 2000 字" */
export function historyNoteTitle(title: string, style: HistoryStyle, length: HistoryLength, scope: { kind: string } = { kind: 'world' }): string {
  return `${title} · ${bookHowText(scope, style, length, ' · ')}`;
}

export interface WriteProgress {
  /** 到目前为止的全文(Markdown) */
  text: string;
  /** 正在写第几次调用(0 起)/ 一共几次 */
  call: number;
  calls: number;
}

/** 分章写时已经写好的一章(篇):写到一半出错后重试,交回来就从下一章接着写 */
export interface WrittenCall {
  text: string;
  provider: AiProviderKind | '';
  model: string;
}

/** 写好的几章接成全文(各章之间空一行) */
export function joinWritten(written: readonly WrittenCall[]): string {
  return written.reduce((s, w) => (s ? `${s}\n\n${w.text}` : w.text), '');
}

export interface WriteHistoryOptions {
  /** 存到哪个世界(saveStore 的世界编号) */
  world: string;
  /** 列传、家传:界面层交进来的人物卡(prompts/lives.ts 的 LifeSource) */
  src?: LifeSource | null;
  signal?: AbortSignal;
  onProgress?: (p: WriteProgress) => void;
  /**
   * 上次写到一半出错时已经写好的前几章(篇,按顺序):这几章不再写,从下一章接着写;前文、用过的开头和"史臣曰"照常从它们取。
   * 必须是同一部书、同一份材料写出来的(调用方核对,见 ui/bookStore.ts)
   */
  written?: readonly WrittenCall[];
  /** 每写好一章(篇)回调一次:到目前为止写好的全部(出错时调用方留着,重试交回 written) */
  onWritten?: (written: WrittenCall[]) => void;
  /** 写完存笔记用的时间(测试用);不给 = 现在 */
  now?: () => Date;
}

/**
 * 写一部史书:一次(短、中篇)或一章一次(长篇)地调 AI,边写边回调 onProgress;写完存进本地笔记并返回。
 * 每章写完扫一遍现实里的词(realWords.ts),命中的句子重写一次。
 * 某一次调用(分章写的一章;一次写完的就是整部)被服务商的内容审核拦下(AiError 'content-filter';网络、额度之类的错不算):
 * 这一次带上"战争、杀伐写得克制"(restrainedLine)自动再写一次,还被拦才抛错。
 * 写完存成这一部的新一版(正在用的就是它;满了去掉最早的那版),返回存好的整条笔记。
 * 没设置 AI / 失败 / 取消都抛 AiError(取消 = code 'aborted');这时不存,旧的几版(同一个键)不动
 */
export async function writeHistory(civ: Civ, opts: BookOptions, o: WriteHistoryOptions): Promise<HistoryNote> {
  const prompts = bookPrompts(civ, opts, o.src);
  if (prompts.empty || !prompts.calls.length) throw new AiError('other', '这段历史里没有史事可写');
  const n = prompts.calls.length;
  const written: WrittenCall[] = (o.written ?? []).slice(0, n);
  let done = joinWritten(written);
  // 扫现实词时,整部书的材料里出现过的词都不算(后面几章会提到前面材料里的名字)
  const material = prompts.calls.map((c) => `${c.head}\n${c.body}`).join('\n');
  for (let i = written.length; i < n; i++) {
    if (o.signal?.aborted) throw new AiError('aborted', '已取消');
    const c = prompts.calls[i];
    const prefix = done ? `${done}\n\n` : '';
    const ask = (restrained: boolean) => {
      o.onProgress?.({ text: done, call: i, calls: n });
      return aiChat(
        { feature: HISTORY_KIND, title: c.title, messages: historyMessages(prompts, i, done, restrained), temperature: c.temperature, maxTokens: c.maxTokens },
        { signal: o.signal, onDelta: (_, full) => o.onProgress?.({ text: prefix + full, call: i, calls: n }) },
      );
    };
    let r: Awaited<ReturnType<typeof aiChat>>;
    try {
      r = await ask(false);
    } catch (e) {
      // 只有内容审核拦下才带"克制"重写一次(分章、一次写完的都一样);别的错直接报
      if (!(e instanceof AiError) || e.code !== 'content-filter') throw e;
      if (o.signal?.aborted) throw new AiError('aborted', '已取消');
      r = await ask(true);
    }
    // 每章写完扫一遍现实里的词,命中的句子让 AI 改一次
    const text = await fixRealWords(r.text.trim(), { material, feature: HISTORY_KIND, title: c.title, signal: o.signal });
    done = prefix + text;
    written.push({ text, provider: r.provider, model: r.model });
    o.onWritten?.(written.slice());
  }
  const last = written[written.length - 1];
  const provider = last?.provider ?? '';
  const model = last?.model ?? '';
  o.onProgress?.({ text: done, call: n - 1, calls: n });
  const stored = bookStoreScope(civ, opts.scope, o.src);
  const key = bookNoteKey(stored, opts.style, opts.length);
  const version: BookVersion = {
    text: done,
    createdAt: (o.now?.() ?? new Date()).toISOString(),
    provider,
    model,
    book: {
      title: prompts.title,
      range: prompts.range,
      scope: stored,
      style: opts.style,
      length: opts.length,
      fp: prompts.fingerprint,
      seed: civ.seed,
      calls: n,
    },
  };
  // 旧的几版按存的这一刻取(写的工夫在阅读页删过、翻过的,照删、照翻)
  const note = addBookVersion(asHistoryNote(getNote(o.world, key)), key, version);
  putNote(o.world, note);
  return note;
}

/** 日期:"9 月 28 日 14:02" */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (x: number) => String(x).padStart(2, '0');
  return `${shortDay(iso)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 日期,不带钟点:"9 月 28 日" */
export function shortDay(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : '';
}

const PROVIDER_NAME: Record<string, string> = { official: '我们的 AI', openai: 'OpenAI', deepseek: 'DeepSeek', bailian: '阿里云百炼', mock: '测试用假 AI' };

/** 谁写的:"DeepSeek · deepseek-chat"(导出的文件里这样写;阅读页那行小字传 sep = "，") */
export function historyWriter(note: Pick<AiNote, 'provider' | 'model'>, sep = ' · '): string {
  const who = PROVIDER_NAME[note.provider] ?? note.provider;
  return [who, note.model && note.model !== note.provider ? note.model : ''].filter(Boolean).join(sep);
}

/** 导出 Markdown:书名 + 一段说明(种子、年份、文体、谁写的)+ 正文。title:界面上显示的书名(世界起了名字时是"某某通史"),不给 = 存的书名 */
export function historyMarkdown(note: HistoryNote, title = note.book.title): string {
  const b = note.book;
  const meta = [
    `「文明与地图」种子 ${b.seed} · ${b.range}`,
    bookHowText(b.scope, b.style, b.length, ' · '),
    `AI 写作(${historyWriter(note)})`,
    note.createdAt.slice(0, 10),
  ].join(' · ');
  return [`# ${title}`, '', `> ${meta}  `, '> 年份、国名、胜负存亡以推演出来的编年史为准;人物、对话等细节由 AI 补写。', '', note.text.trim(), ''].join('\n');
}

/** 导出的文件名:"世界通史-史书体-种子7.md"(去掉文件名里不能用的字符) */
export function historyFileName(note: HistoryNote, title = note.book.title): string {
  const b = note.book;
  const base = `${title}-${bookStyleLabel(b.scope, b.style)}-种子${b.seed}`.replace(/[\\/:*?"<>|\s]+/g, '');
  return `${base}.md`;
}
