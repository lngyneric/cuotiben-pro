// 内容源与页面划分草稿 —— 阶段 1 能力二（P0）。
//
// 三路来源同一规矩：抽取或检索到什么就用什么，检索不到就明说，不编内容。
// - upload_text：复用 AI 助手附件抽取（attachments.ts 的
//   extractSingleTextFile），单文件 8000 字、合计 16000 字，超限明确报错
//   不截断（与 processAttachments 的截断行为不同，见清单 word_limit）。
// - reference_ppt：PPTX 逐页抽文字 + 主题色（pptx-text.ts）；单文件
//   25MB 上限是上传文件上限，与 MCP 单次 2MB 调用限额是两回事——抽取在
//   服务端做，只有抽出的文本进 MCP，不得以 2MB 为由把上传上限压到 2MB。
//   25MB 的文件走页面 multipart 上传路由（routes/api/ai-assistant/
//   presentations/sources.ts），MCP 只能带 2MB 以内的 base64。
// - wiki_kb：只检索已发布内容（post.status = 'published'，草稿绝不进
//   清单）；blog_html 文档按现有可见性（canViewBlogHtml）过滤，'self'
//   文档只对上传者本人与管理员可见。无命中时返回空清单并由调用方明确
//   回“无可用来源”，不生成空编稿。
// - 优先级：同一主题同时有上传文件与知识库命中时，成稿以上传文件为准，
//   知识库只作补充且在留痕中分开标注（outline 页的 primaryKind 与
//   page_source_refs 的顺序体现这一点）。
//
// 跨模块 import 的例外（与 service.ts 的 config/notify 同款）：post 表
// 直接查（不 import posts 模块）；blog_html 的 list/get/可见性复用
// blog-html 模块（ai-assistant/doc-index.ts 的同款做法），不另写一套。

import { and, eq, like, or } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  post,
  presentationOutline,
  presentationSource,
  type PresentationOutline,
  type PresentationSource,
} from '@/config/db/schema';
import {
  extractSingleTextFile,
  MAX_TEXT_PER_FILE_CHARS,
  MAX_TOTAL_TEXT_CHARS,
} from '@/modules/ai-assistant/attachments';
import { canViewBlogHtml, isBlogAdmin } from '@/modules/blog-html/service';
import { getBlogHtml, listBlogHtml } from '@/modules/blog-html/storage';
import { getUuid } from '@/lib/hash';

import { PresentonError } from './errors';
import type { LayoutAssignment, PageSourceRef, SourceKind } from './job-meta';
import { isLayoutCode, suggestLayout, type LayoutCode } from './layouts';
import {
  judgeOutlineGrouping,
  parseOutlineVerdict,
  resolveOutlineJevConfig,
  resolveOutlineLlmConfig,
  splitUploadTextByLlm,
  type LlmPageGrouping,
  type OutlineSplitMode,
  type OutlineVerdict,
} from './outline-llm';
import { extractPptxSlides } from './pptx-text';
import type { JevTransport } from '@/modules/ai-assistant/service';

export type { SourceKind } from './job-meta';

/** 参考 PPT 单文件上限 25MB（上传文件上限，非 MCP 调用限额）。 */
export const REFERENCE_PPT_MAX_BYTES = 25 * 1024 * 1024;
/** 页面划分：每页正文上限（字符），超了按段落拆页。 */
export const OUTLINE_PAGE_MAX_CHARS = 800;
/** 每页要点上限。 */
export const OUTLINE_PAGE_MAX_POINTS = 6;

/** 注入用依赖（测试桩；生产调用不传，走真实 Magpie/Jev）。 */
export interface BuildOutlineDeps {
  jevTransport?: JevTransport;
  fetchImpl?: typeof fetch;
}

/** 重分粒度：页正文上限减半、要点上限 4 条。 */
export const FINE_PACK_LIMITS = { maxChars: 400, maxPoints: 4 };

interface PageBlock {
  title: string;
  points: string[];
  layout?: LayoutCode;
  layoutReason?: string;
}

export interface SourceOwner {
  userId: string;
  tokenId?: string | null;
}

export interface SourceViewer extends SourceOwner {
  isAdmin: boolean;
}

function isOwner(
  row: { ownerUserId: string; ownerTokenId: string | null },
  owner: SourceOwner
): boolean {
  return (
    row.ownerUserId === owner.userId &&
    (row.ownerTokenId ?? null) === (owner.tokenId ?? null)
  );
}

function notFound(what: string): PresentonError {
  return new PresentonError('invalid_input', `${what}不存在`, 404);
}

export function sourcePublicView(row: PresentationSource): {
  sourceId: string;
  kind: SourceKind;
  name: string;
  status: string;
  extractChars: number;
  pageCount: number | null;
} {
  return {
    sourceId: row.id,
    kind: row.kind as SourceKind,
    name: row.name,
    status: row.status,
    extractChars: row.extractChars,
    pageCount: row.pageCount,
  };
}

// ─── 上传文本 ───────────────────────────────────────────────────────────────

export async function registerUploadText(
  owner: SourceOwner,
  file: { name: string; mime: string; base64: string }
): Promise<PresentationSource> {
  const { name, text, chars } = await extractSingleTextFile(file);
  if (chars > MAX_TEXT_PER_FILE_CHARS) {
    throw new PresentonError(
      'invalid_input',
      `「${name}」抽取到 ${chars} 字，超过单文件 ${MAX_TEXT_PER_FILE_CHARS} 字上限，请拆小再登记`
    );
  }
  const [row] = await db()
    .insert(presentationSource)
    .values({
      id: getUuid(),
      ownerUserId: owner.userId,
      ownerTokenId: owner.tokenId ?? null,
      kind: 'upload_text',
      name,
      status: text ? 'ready' : 'empty',
      extractChars: chars,
      pageCount: null,
      text,
      meta: null,
    })
    .returning();
  return row;
}

/** 页面 multipart 上传路由用的字节版入口（与 base64 版同一校验）。 */
export async function registerUploadTextBytes(
  owner: SourceOwner,
  file: { name: string; mime: string; bytes: Buffer }
): Promise<PresentationSource> {
  return registerUploadText(owner, {
    name: file.name,
    mime: file.mime,
    base64: file.bytes.toString('base64'),
  });
}

// ─── 参考 PPT ───────────────────────────────────────────────────────────────

export type ReferencePptUse = 'content' | 'style' | 'both';

export async function registerReferencePpt(
  owner: SourceOwner,
  file: { name: string; bytes: Buffer },
  use: ReferencePptUse = 'content'
): Promise<PresentationSource> {
  const name = (file.name || '').split(/[\\/]/).pop() || 'file.pptx';
  if (!/\.pptx$/i.test(name))
    throw new PresentonError(
      'invalid_input',
      `参考 PPT 只接受 .pptx 文件，收到「${name}」`
    );
  if (file.bytes.length > REFERENCE_PPT_MAX_BYTES) {
    const mb = (file.bytes.length / (1024 * 1024)).toFixed(1);
    throw new PresentonError(
      'invalid_input',
      `参考 PPT「${name}」${mb}MB，超过 25MB 上限，无法直接抽取。请先转 PDF（抽文字当内容源）或转图片（当版式参考）再提交。`
    );
  }
  const extracted = extractPptxSlides(file.bytes);
  if (!extracted)
    throw new PresentonError(
      'invalid_input',
      `参考 PPT「${name}」不是有效的 PPTX 文件，无法抽取文字与结构`
    );
  const text = extracted.slides.map((s) => s.text).join('\n');
  const chars = text.length;
  if (chars > MAX_TEXT_PER_FILE_CHARS) {
    throw new PresentonError(
      'invalid_input',
      `参考 PPT「${name}」抽取到 ${chars} 字，超过单文件 ${MAX_TEXT_PER_FILE_CHARS} 字上限，请拆成多份或先转 PDF 分段登记`
    );
  }
  const [row] = await db()
    .insert(presentationSource)
    .values({
      id: getUuid(),
      ownerUserId: owner.userId,
      ownerTokenId: owner.tokenId ?? null,
      kind: 'reference_ppt',
      name,
      status: text ? 'ready' : 'empty',
      extractChars: chars,
      pageCount: extracted.slides.length,
      text,
      // 逐页文本存进 meta：outline 按原稿页序成页时要按页取文本，整稿
      // join 后的文本无法无损还原页边界。
      meta: JSON.stringify({
        use,
        slides: extracted.slides.map((s) => ({
          pageNo: s.pageNo,
          title: s.title,
          text: s.text,
        })),
        themeColors: extracted.themeColors,
      }),
    })
    .returning();
  return row;
}

// ─── 知识库检索（个人权限范围） ─────────────────────────────────────────────

export interface KbHit {
  refType: 'post' | 'html';
  refId: string;
  title: string;
  snippet: string;
  sourceRef: string;
}

function snippetAround(text: string, keyword: string): string {
  const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx < 0) return text.slice(0, 120);
  const start = Math.max(0, idx - 40);
  return (start > 0 ? '…' : '') + text.slice(start, start + 120);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 按关键词检索调用人可见的已整理内容：已发布 blog 文章 + 可见的
 * /wiki/html 文档。草稿（post.status != 'published'）与无权查看的
 * html 文档（visibility self 且非本人/非管理员）绝不进清单。
 */
export async function searchWikiKb(
  viewer: SourceViewer,
  keyword: string
): Promise<{ hits: KbHit[] }> {
  const kw = (keyword || '').trim();
  if (!kw) throw new PresentonError('invalid_input', '请给出知识库检索关键词');
  if (kw.length > 200)
    throw new PresentonError('invalid_input', '检索关键词过长');
  // LIKE 通配符 %/_ 从关键词里剥掉：否则一个 % 就能把全部已发布文章
  // 都命中（可见范围内无泄漏，但属于非预期的宽匹配）。
  const pattern = `%${kw.replace(/[%_]/g, '')}%`;
  const posts = await db()
    .select()
    .from(post)
    .where(
      and(
        eq(post.type, 'article'),
        eq(post.status, 'published'),
        or(
          like(post.title, pattern),
          like(post.content, pattern),
          like(post.tags, pattern)
        )
      )
    )
    .limit(20);
  const hits: KbHit[] = posts.map(
    (p: {
      id: string;
      title: string;
      slug: string;
      description: string | null;
      content: string | null;
    }) => ({
      refType: 'post' as const,
      refId: p.id,
      title: p.title,
      snippet: snippetAround(
        `${p.title}\n${p.description || ''}\n${p.content || ''}`,
        kw
      ),
      sourceRef: p.slug,
    })
  );
  // /wiki/html 文档：标题/关键词/正文命中其一即收；可见性按现有规则判。
  try {
    const docs = await listBlogHtml();
    for (const doc of docs) {
      if (hits.length >= 20) break;
      if (
        !canViewBlogHtml(doc, {
          userId: viewer.userId,
          isAdmin: viewer.isAdmin,
        })
      )
        continue;
      const haystack = `${doc.title} ${doc.keywords} ${doc.category}`;
      let text = '';
      if (haystack.toLowerCase().includes(kw.toLowerCase())) {
        text = doc.description || '';
      } else {
        const got = await getBlogHtml(doc.key);
        if (!got) continue;
        text = stripHtml(got.content);
        if (!text.toLowerCase().includes(kw.toLowerCase())) continue;
      }
      hits.push({
        refType: 'html',
        refId: doc.key,
        title: doc.title || doc.key,
        snippet: snippetAround(text || haystack, kw),
        sourceRef: doc.key,
      });
    }
  } catch {
    // html 索引失败不拖垮文章检索：只返回文章命中。
  }
  return { hits };
}

/** 勾选知识库命中条目后登记为来源（只认已发布/可见的条目）。 */
export async function registerWikiKb(
  owner: SourceOwner,
  viewer: SourceViewer,
  items: Array<{ refType: 'post' | 'html'; refId: string }>
): Promise<PresentationSource> {
  if (!items || items.length === 0)
    throw new PresentonError(
      'invalid_input',
      '请先勾选知识库命中条目再登记来源'
    );
  if (items.length > 10)
    throw new PresentonError('invalid_input', '一次最多勾选 10 条知识库内容');
  const parts: string[] = [];
  const metaItems: Array<{ refType: string; refId: string; title: string }> =
    [];
  let totalChars = 0;
  for (const item of items) {
    if (item.refType === 'post') {
      const [row] = await db()
        .select()
        .from(post)
        .where(eq(post.id, item.refId))
        .limit(1);
      if (!row || row.status !== 'published' || row.type !== 'article')
        throw notFound(`知识库条目 ${item.refId}`);
      const text = (row.content || '').trim();
      if (text.length > MAX_TEXT_PER_FILE_CHARS)
        throw new PresentonError(
          'invalid_input',
          `知识库文章「${row.title}」正文 ${text.length} 字，超过单篇 ${MAX_TEXT_PER_FILE_CHARS} 字上限`
        );
      totalChars += text.length;
      parts.push(`【知识库：${row.title}】\n${text}`);
      metaItems.push({ refType: 'post', refId: row.id, title: row.title });
    } else {
      const got = await getBlogHtml(item.refId);
      if (
        !got ||
        !canViewBlogHtml(got.meta, {
          userId: viewer.userId,
          isAdmin: viewer.isAdmin,
        })
      )
        throw notFound(`知识库文档 ${item.refId}`);
      const text = stripHtml(got.content);
      if (text.length > MAX_TEXT_PER_FILE_CHARS)
        throw new PresentonError(
          'invalid_input',
          `知识库文档「${got.meta.title}」正文 ${text.length} 字，超过单篇 ${MAX_TEXT_PER_FILE_CHARS} 字上限`
        );
      totalChars += text.length;
      parts.push(`【知识库：${got.meta.title}】\n${text}`);
      metaItems.push({
        refType: 'html',
        refId: item.refId,
        title: got.meta.title || item.refId,
      });
    }
  }
  if (totalChars > MAX_TOTAL_TEXT_CHARS)
    throw new PresentonError(
      'invalid_input',
      `知识库来源合计 ${totalChars} 字，超过合计 ${MAX_TOTAL_TEXT_CHARS} 字上限，请减少勾选条目`
    );
  const text = parts.join('\n\n');
  const [row] = await db()
    .insert(presentationSource)
    .values({
      id: getUuid(),
      ownerUserId: owner.userId,
      ownerTokenId: owner.tokenId ?? null,
      kind: 'wiki_kb',
      name:
        metaItems
          .map((i) => i.title)
          .join('、')
          .slice(0, 100) || '知识库来源',
      status: text ? 'ready' : 'empty',
      extractChars: totalChars,
      pageCount: metaItems.length,
      text,
      meta: JSON.stringify({ items: metaItems }),
    })
    .returning();
  return row;
}

// ─── 来源读取（归属校验） ───────────────────────────────────────────────────

export async function getOwnedSource(
  id: string,
  owner: SourceOwner
): Promise<PresentationSource> {
  const [row] = await db()
    .select()
    .from(presentationSource)
    .where(eq(presentationSource.id, id))
    .limit(1);
  if (!row || !isOwner(row, owner)) throw notFound('内容源');
  return row;
}

export async function getOwnedSources(
  ids: string[],
  owner: SourceOwner
): Promise<PresentationSource[]> {
  const rows: PresentationSource[] = [];
  for (const id of ids) rows.push(await getOwnedSource(id, owner));
  return rows;
}

// ─── Outline ────────────────────────────────────────────────────────────────

export interface OutlinePage {
  pageNo: number;
  title: string;
  points: string[];
  layout: LayoutCode;
  layoutReason: string;
  sources: Array<{
    sourceId: string;
    sourceKind: SourceKind;
    locator: string;
  }>;
  primaryKind: SourceKind;
  insufficient?: boolean;
  note?: string;
  styleRef?: { sourceId: string; note: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseOutlinePages(
  value: string | null | undefined
): OutlinePage[] | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: OutlinePage[] = [];
  for (const item of parsed as unknown[]) {
    if (!isRecord(item)) return null;
    if (
      typeof item.pageNo !== 'number' ||
      !Number.isInteger(item.pageNo) ||
      item.pageNo < 1
    )
      return null;
    if (typeof item.title !== 'string' || !item.title.trim()) return null;
    if (!Array.isArray(item.points)) return null;
    if (typeof item.layout !== 'string' || !isLayoutCode(item.layout))
      return null;
    if (typeof item.layoutReason !== 'string') return null;
    if (!Array.isArray(item.sources)) return null;
    const sources: OutlinePage['sources'] = [];
    for (const s of item.sources as unknown[]) {
      if (!isRecord(s)) return null;
      if (typeof s.sourceId !== 'string' || !s.sourceId) return null;
      if (
        typeof s.sourceKind !== 'string' ||
        !['upload_text', 'reference_ppt', 'wiki_kb'].includes(s.sourceKind)
      )
        return null;
      if (typeof s.locator !== 'string' || !s.locator) return null;
      sources.push({
        sourceId: s.sourceId,
        sourceKind: s.sourceKind as SourceKind,
        locator: s.locator,
      });
    }
    if (
      typeof item.primaryKind !== 'string' ||
      !['upload_text', 'reference_ppt', 'wiki_kb'].includes(item.primaryKind)
    )
      return null;
    out.push({
      pageNo: item.pageNo,
      title: item.title,
      points: item.points.filter((p) => typeof p === 'string'),
      layout: item.layout,
      layoutReason: item.layoutReason,
      sources,
      primaryKind: item.primaryKind as SourceKind,
      ...(item.insufficient === true ? { insufficient: true } : {}),
      ...(typeof item.note === 'string' && item.note
        ? { note: item.note }
        : {}),
      ...(isRecord(item.styleRef) &&
      typeof item.styleRef.sourceId === 'string' &&
      typeof item.styleRef.note === 'string'
        ? {
            styleRef: {
              sourceId: item.styleRef.sourceId,
              note: item.styleRef.note,
            },
          }
        : {}),
    });
  }
  return out;
}

/** 按标题行（# / ##）或空行切段；无标题时按段落切。 */
function splitSections(text: string): Array<{ heading: string; body: string }> {
  const lines = text.split('\n');
  const sections: Array<{ heading: string; body: string }> = [];
  let current: { heading: string; body: string } | null = null;
  for (const line of lines) {
    const h = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (h) {
      if (current) sections.push(current);
      current = { heading: h[2].trim(), body: '' };
      continue;
    }
    if (!current) current = { heading: '', body: '' };
    current.body += (current.body ? '\n' : '') + line;
  }
  if (current) sections.push(current);
  return sections
    .map((s) => ({ heading: s.heading, body: s.body.trim() }))
    .filter((s) => s.heading || s.body);
}

function pointsFromParagraphs(
  body: string,
  maxPoints = OUTLINE_PAGE_MAX_POINTS
): string[] {
  return body
    .split(/\n+/)
    .map((p) => p.replace(/^[-*•\s]+/, '').trim())
    .filter(Boolean)
    .map((p) => (p.length > 200 ? `${p.slice(0, 200)}…` : p))
    .slice(0, maxPoints);
}

/** 段落累积成页（每页正文不超上限、要点不超上限）。mergeSameTitle=false 时每个块另起一页（LLM 分组：块即 LLM 定的一页，不跨块合并）。 */
function packPages(
  blocks: PageBlock[],
  limits: { maxChars: number; maxPoints: number } = {
    maxChars: OUTLINE_PAGE_MAX_CHARS,
    maxPoints: OUTLINE_PAGE_MAX_POINTS,
  },
  mergeSameTitle = true
): PageBlock[] {
  const pages: PageBlock[] = [];
  let cur: (PageBlock & { chars: number }) | null = null;
  const flush = () => {
    if (cur && cur.points.length > 0)
      pages.push({
        title: cur.title,
        points: cur.points,
        ...(cur.layout
          ? { layout: cur.layout, layoutReason: cur.layoutReason ?? '' }
          : {}),
      });
    cur = null;
  };
  for (const block of blocks) {
    // 不同标题 = 不同主题：换主题时另起一页，不把两个主题并进一页
    // （清单验收：多主题材料的页数与主题划分须与确认版一致）。
    // 同一主题过长时仍按字数/要点数在主题内断页。
    if (
      cur &&
      cur.points.length > 0 &&
      (cur.title !== block.title || !mergeSameTitle)
    )
      flush();
    for (const pt of block.points) {
      if (!cur)
        cur = {
          title: block.title,
          points: [],
          chars: 0,
          ...(block.layout
            ? { layout: block.layout, layoutReason: block.layoutReason ?? '' }
            : {}),
        };
      if (
        cur.points.length > 0 &&
        (cur.chars + pt.length > limits.maxChars ||
          cur.points.length >= limits.maxPoints)
      ) {
        flush();
        cur = {
          title: block.title,
          points: [],
          chars: 0,
          ...(block.layout
            ? { layout: block.layout, layoutReason: block.layoutReason ?? '' }
            : {}),
        };
      }
      cur.points.push(pt);
      cur.chars += pt.length;
    }
  }
  flush();
  return pages;
}

function metaOf(row: PresentationSource): Record<string, any> {
  try {
    return row.meta ? (JSON.parse(row.meta) as Record<string, any>) : {};
  } catch {
    return {};
  }
}

function finishPage(
  pageNo: number,
  p: {
    title: string;
    points: string[];
    layout?: LayoutCode;
    layoutReason?: string;
  },
  kind: SourceKind,
  source: PresentationSource,
  locator: string,
  styleRef?: { sourceId: string; note: string },
  note?: string
): OutlinePage {
  // LLM 分组给出版式时用它（已校验为合法版式码），否则按规则建议。
  const { layout, reason } =
    p.layout && isLayoutCode(p.layout)
      ? { layout: p.layout, reason: p.layoutReason ?? '' }
      : suggestLayout({
          pointCount: p.points.length,
          hasMainImage: false,
        });
  const textLen = p.title.length + p.points.reduce((n, x) => n + x.length, 0);
  const insufficient = textLen < 40;
  return {
    pageNo,
    title: p.title.slice(0, 60) || `第 ${pageNo} 页`,
    points: p.points,
    layout,
    layoutReason: reason,
    sources: [{ sourceId: source.id, sourceKind: kind, locator }],
    primaryKind: kind,
    ...(insufficient
      ? {
          insufficient: true,
          note: '来源不足：本页来源片段不足以支撑完整内容，仅保留标题与要点，不扩写。',
        }
      : {}),
    ...(note && !insufficient ? { note } : {}),
    ...(styleRef ? { styleRef } : {}),
  };
}

/**
 * 按已登记来源产出页面划分草稿：上传文本按标题/段落分主题成页，参考 PPT
 * 一页原稿一页成稿，知识库一篇文章一页；顺序即优先级（上传 > 参考 PPT >
 * 知识库），知识库页标注“知识库补充”。
 *
 * 轻量路（2026-11-26）：上传文本优先走 Magpie LLM 分组（只定标题 + 段落
 * 归属 + 版式建议，要点仍从来源原文取），失败回退确定性拆分；草稿建好后
 * 调 Jev 逐页判定分组（与意图的相关性 + 页内一致性，阈值 0.6），不通过
 * 自动重分一次（更细粒度），再不通过标疑点返回；Jev 不可用时判定跳过、
 * 不阻塞。判定结论写进 outline 行的 verdict 列（migration 0005）。
 */
export async function buildOutline(
  owner: SourceOwner,
  sourceIds: string[],
  opts?: { intent?: string; deps?: BuildOutlineDeps }
): Promise<PresentationOutline> {
  if (!sourceIds || sourceIds.length === 0)
    throw new PresentonError('invalid_input', '请先登记内容源再做页面划分');
  if (sourceIds.length > 10)
    throw new PresentonError('invalid_input', '一次最多用 10 个内容源做划分');
  const sources = await getOwnedSources(sourceIds, owner);
  for (const s of sources) {
    if (s.status !== 'ready')
      throw new PresentonError(
        'invalid_input',
        `内容源「${s.name}」未抽到文字（empty），不能进入页面划分`
      );
  }
  const totalChars = sources.reduce((n, s) => n + s.extractChars, 0);
  if (totalChars > MAX_TOTAL_TEXT_CHARS)
    throw new PresentonError(
      'invalid_input',
      `内容源合计 ${totalChars} 字，超过合计 ${MAX_TOTAL_TEXT_CHARS} 字上限，请减少来源`
    );

  // 版式参考（style/both 的参考 PPT）：主题色冲突时以既定主题为准。
  const styleRefs: Array<{ sourceId: string; note: string }> = [];
  for (const s of sources) {
    if (s.kind !== 'reference_ppt') continue;
    const meta = metaOf(s);
    if (meta.use !== 'style' && meta.use !== 'both') continue;
    const colors: string[] = Array.isArray(meta.themeColors)
      ? meta.themeColors
      : [];
    styleRefs.push({
      sourceId: s.id,
      note:
        `版式参考：参考 PPT「${s.name}」的分页方式与配色` +
        (colors.length > 0 ? `（原稿主题色 ${colors.join('、')}）` : '') +
        '；与既定主题冲突时以既定主题为准。',
    });
  }

  // 用户意图（Jev 判定与 LLM 分组的 query）：调用方给 intent 时用它，
  // 否则用来源名拼一个（MCP 只传 sourceIds 时无意图文本）。
  const intentText =
    opts?.intent?.trim().slice(0, 500) ||
    sources.map((s) => s.name).join('、').slice(0, 200) ||
    'PPT';
  const llmConfig = await resolveOutlineLlmConfig().catch(() => null);
  const jevConfig = resolveOutlineJevConfig();

  // 页面构建（一次尝试）：上传文本走 LLM 分组（失败回退确定性拆分），
  // 参考 PPT / 知识库保持 1:1 确定性映射。重分时用更细粒度。
  const buildPagesOnce = async (fine: boolean) => {
    const pages: OutlinePage[] = [];
    let splitMode: OutlineSplitMode = 'deterministic';
    const ordered = [...sources].sort((a, b) => {
      const rank = (k: string) =>
        k === 'upload_text' ? 0 : k === 'reference_ppt' ? 1 : 2;
      return rank(a.kind) - rank(b.kind);
    });
    // 上传文本的段落（LLM 分组与确定性拆分共用同一份切段）。
    const sectionsBySource = new Map<
      string,
      Array<{ heading: string; body: string }>
    >();
    for (const s of ordered) {
      if (s.kind === 'upload_text')
        sectionsBySource.set(s.id, splitSections(s.text));
    }
    // LLM 分组（仅上传文本，并行；失败的源回退确定性拆分）。
    const llmGroupings = new Map<string, LlmPageGrouping[]>();
    if (llmConfig) {
      await Promise.all(
        [...sectionsBySource.entries()].map(async ([sourceId, sections]) => {
          const grouping = await splitUploadTextByLlm({
            baseUrl: llmConfig.baseUrl,
            apiKey: llmConfig.apiKey,
            intent: intentText,
            sections,
            fine,
            fetchImpl: opts?.deps?.fetchImpl,
          });
          if (grouping) llmGroupings.set(sourceId, grouping);
        })
      );
    }
  for (const source of ordered) {
    const kind = source.kind as SourceKind;
    const styleRef = styleRefs[0];
    if (kind === 'upload_text') {
      const sections = sectionsBySource.get(source.id) ?? [];
      const grouping = llmGroupings.get(source.id);
      let blocks: PageBlock[];
      if (grouping) {
        // LLM 分组：块即 LLM 定的一页（标题 + 段落归属 + 版式建议），
        // 要点仍从来源原文取，不编内容；跨块不合并。
        splitMode = 'llm';
        blocks = grouping.map((g) => ({
          title: g.title,
          points: g.sectionIndexes.flatMap((i) =>
            pointsFromParagraphs(sections[i]?.body ?? '')
          ),
          ...(isLayoutCode(g.layout)
            ? {
                layout: g.layout as LayoutCode,
                layoutReason: g.reason || 'LLM 分组建议',
              }
            : {}),
        }));
      } else {
        blocks = sections.map((sec) => {
          const points = pointsFromParagraphs(sec.body);
          return {
            title: sec.heading || (points[0]?.slice(0, 24) ?? source.name),
            points,
          };
        });
      }
      const packed = packPages(
        blocks,
        fine ? FINE_PACK_LIMITS : undefined,
        grouping ? false : true
      );
      for (const p of packed) {
        pages.push(
          finishPage(
            pages.length + 1,
            p,
            kind,
            source,
            `正文第 ${pages.length + 1} 页`,
            styleRef
          )
        );
      }
    } else if (kind === 'reference_ppt') {
      const meta = metaOf(source);
      if (meta.use === 'style') continue; // 纯版式参考不产生内容页
      const slides: Array<{ pageNo: number; title: string; text: string }> =
        Array.isArray(meta.slides) ? meta.slides : [];
      for (const slide of slides) {
        const lines = (slide.text || '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        const points = lines
          .slice(1)
          .map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l))
          .slice(0, OUTLINE_PAGE_MAX_POINTS);
        pages.push(
          finishPage(
            pages.length + 1,
            {
              title: slide.title || lines[0] || `第 ${slide.pageNo} 页`,
              points,
            },
            kind,
            source,
            `原稿第 ${slide.pageNo} 页`,
            styleRef
          )
        );
      }
    } else {
      // wiki_kb：一篇一页（meta.items 顺序即勾选顺序）。
      const meta = metaOf(source);
      const items: Array<{ refType: string; refId: string; title: string }> =
        Array.isArray(meta.items) ? meta.items : [];
      const chunks = source.text.split('【知识库：').filter(Boolean);
      items.forEach((item, i) => {
        const chunk = (chunks[i] ?? '').replace(/^[^】]*】\n?/, '');
        const points = pointsFromParagraphs(chunk, 4);
        pages.push(
          finishPage(
            pages.length + 1,
            { title: item.title, points },
            kind,
            source,
            item.refType === 'post'
              ? `知识库文章 ${item.refId}`
              : `知识库文档 ${item.refId}`,
            styleRef,
            '知识库补充'
          )
        );
      });
    }
  }
    if (pages.length > 50)
      throw new PresentonError(
        'invalid_input',
        `页面划分 ${pages.length} 页，超过 50 页上限，请减少来源内容`
      );
    return { pages, splitMode };
  };

  // Jev 分组判定：不通过自动重分一次（更细粒度），再不通过标疑点返回；
  // Jev 不可用时判定跳过、不阻塞。结构性页面（原稿/文章一页一页映射）
  // 无法重分，不通过直接标疑点。
  let pages: OutlinePage[] = [];
  let splitMode: OutlineSplitMode = 'deterministic';
  let verdict: OutlineVerdict | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const built = await buildPagesOnce(attempt === 2);
    pages = built.pages;
    splitMode = built.splitMode;
    if (pages.length === 0)
      throw new PresentonError(
        'invalid_input',
        '来源内容为空，无法产出页面划分（无可用来源）'
      );
    const judged = await judgeOutlineGrouping({
      apiKey: jevConfig.apiKey,
      proxyUrl: jevConfig.proxyUrl,
      intent: intentText,
      pages,
      jevTransport: opts?.deps?.jevTransport,
    });
    if (!judged) {
      verdict = {
        status: 'skipped',
        splitMode,
        attempts: attempt,
        scores: [],
        warnings: [
          'Jev 分组判定不可用（无 key 或调用失败），草稿未经判定，请在确认时核对页面划分。',
        ],
        judgedAt: Date.now(),
      };
      break;
    }
    const failed = judged.scores.filter((s) => s.failed);
    if (failed.length === 0) {
      verdict = {
        status: 'pass',
        splitMode,
        attempts: attempt,
        scores: judged.scores,
        warnings: [],
        judgedAt: Date.now(),
      };
      break;
    }
    const canResplit = pages.some((p) => p.primaryKind === 'upload_text');
    if (attempt === 2 || !canResplit) {
      verdict = {
        status: 'needs_review',
        splitMode,
        attempts: attempt,
        scores: judged.scores,
        warnings: [
          ...failed.map(
            (f) => `第 ${f.pageNo} 页疑似分组错误：${f.reasons.join('；')}`
          ),
          attempt === 2
            ? '已自动重分一次仍不通过，请在确认时核对疑点页（可改标题/要点、删页、合并页）。'
            : '疑点页为结构性页面（原稿/文章一页一页映射），无法自动重分，请在确认时核对。',
        ],
        judgedAt: Date.now(),
      };
      break;
    }
    // 第一次不通过且可重分：循环一次，用更细粒度重分。
  }
  const [row] = await db()
    .insert(presentationOutline)
    .values({
      id: getUuid(),
      ownerUserId: owner.userId,
      ownerTokenId: owner.tokenId ?? null,
      sourceIds: JSON.stringify(sourceIds),
      pages: JSON.stringify(pages),
      status: 'draft',
      version: 1,
      verdict: verdict ? JSON.stringify(verdict) : null,
    })
    .returning();
  return row;
}

export async function getOwnedOutline(
  id: string,
  owner: SourceOwner
): Promise<PresentationOutline> {
  const [row] = await db()
    .select()
    .from(presentationOutline)
    .where(eq(presentationOutline.id, id))
    .limit(1);
  if (!row || !isOwner(row, owner)) throw notFound('页面划分草稿');
  return row;
}

/** 读 outline 行的分组判定结论（migration 0005 verdict 列）；结构不对返回 null。 */
export function outlineVerdictView(
  row: PresentationOutline
): OutlineVerdict | null {
  return parseOutlineVerdict(row.verdict);
}

/** 确认 outline：可整体替换页面（改标题/要点/版式），只改划分不重抽。 */
export async function confirmOutline(
  owner: SourceOwner,
  outlineId: string,
  pages?: OutlinePage[]
): Promise<PresentationOutline> {
  const row = await getOwnedOutline(outlineId, owner);
  let finalPages = parseOutlinePages(row.pages);
  if (!finalPages) throw new PresentonError('invalid_input', '草稿数据损坏');
  if (pages !== undefined) {
    const validated = parseOutlinePages(JSON.stringify(pages));
    if (!validated || validated.length === 0)
      throw new PresentonError('invalid_input', '确认的页面划分不合法');
    validated.forEach((p, i) => {
      if (p.pageNo !== i + 1)
        throw new PresentonError(
          'invalid_input',
          '页面划分的页码必须从 1 开始连续'
        );
    });
    if (validated.length > 50)
      throw new PresentonError('invalid_input', '页面划分超过 50 页上限');
    const allowedSources: Set<string> = new Set(
      JSON.parse(row.sourceIds) as string[]
    );
    for (const p of validated) {
      for (const s of p.sources) {
        if (!allowedSources.has(s.sourceId))
          throw new PresentonError(
            'invalid_input',
            `第 ${p.pageNo} 页引用了未登记的来源`
          );
      }
    }
    finalPages = validated;
  }
  const [updated] = await db()
    .update(presentationOutline)
    .set({
      pages: JSON.stringify(finalPages),
      status: 'confirmed',
      version: row.version + 1,
      updatedAt: new Date(),
      // 用户改了页面划分：草稿期判定结论作废（分组已不是判定的那一份）。
      ...(pages !== undefined ? { verdict: null } : {}),
    })
    .where(eq(presentationOutline.id, row.id))
    .returning();
  return updated;
}

/** 按已确认 outline 组装下发内容：每页只用该页 page_source_refs 的片段。 */
export function assembleOutlineContent(
  outline: PresentationOutline,
  sourcesById: Map<string, PresentationSource>
): {
  content: string;
  layoutAssignments: LayoutAssignment[];
  pageSourceRefs: PageSourceRef[];
} {
  const pages = parseOutlinePages(outline.pages);
  if (!pages) throw new PresentonError('invalid_input', '页面划分草稿数据损坏');
  const parts: string[] = [];
  const layoutAssignments: LayoutAssignment[] = [];
  const pageSourceRefs: PageSourceRef[] = [];
  for (const page of pages) {
    const sourceNames = page.sources
      .map((s) => sourcesById.get(s.sourceId)?.name ?? s.sourceId)
      .join('、');
    const lines = [`【第 ${page.pageNo} 页】${page.title}`];
    if (page.points.length > 0) {
      lines.push('要点：');
      for (const pt of page.points) lines.push(`- ${pt}`);
    }
    if (page.insufficient)
      lines.push('（本页来源不足：仅保留标题与要点，不扩写。）');
    lines.push(`（来源：${sourceNames}）`);
    if (page.styleRef) lines.push(`（${page.styleRef.note}）`);
    parts.push(lines.join('\n'));
    layoutAssignments.push({
      pageNo: page.pageNo,
      layout: page.layout,
      reason: page.layoutReason,
    });
    pageSourceRefs.push({
      pageNo: page.pageNo,
      sources: page.sources.map((s) => ({
        sourceId: s.sourceId,
        sourceKind: s.sourceKind,
        locator: s.locator,
      })),
    });
  }
  return {
    content: parts.join('\n\n'),
    layoutAssignments,
    pageSourceRefs,
  };
}

/** 供调用方组装 viewer（admin 判定走 blog-html 的角色查询）。 */
export async function viewerFor(
  userId: string,
  tokenId?: string | null
): Promise<SourceViewer> {
  return {
    userId,
    tokenId: tokenId ?? null,
    isAdmin: await isBlogAdmin(userId),
  };
}
