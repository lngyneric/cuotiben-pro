// 任务留痕字段 —— 阶段 0 落结构（实施清单“来源留痕”“版式注册表”）。
//
// 三个 JSON 列存在 presentation_job 表上（text 存 JSON 字符串）：
// - layout_assignments：每页版式与选择理由（阶段 1 的 outline 确认后写入；
//   阶段 0 只定义结构，不写值——纯提示词生成时版式由 Presenton 定，
//   wiki 不编一个假的版式记录）。
// - page_source_refs：每页来源引用（阶段 1 内容源写入；阶段 0 只定义结构）。
// - element_index：逐页元素索引（下载盖章时写入，见 element-index.ts）。
// 本文件只做结构校验与序列化：写之前先过 parse*，读出来先过 parse*，
// 坏结构一律按“无留痕”处理，不抛错、不让坏 JSON 拖垮任务查询。
//
// 2026-11-25 用户定的口径（阶段 1 按此实现，阶段 0 结构与之兼容）：
// - 内容源字数口径维持附件现行口径（单文件 8000 字、合计 16000 字），
//   不留放宽口子——留痕结构只记来源与定位，不另设字数字段。
// - wiki_kb 只指已发布内容，不含草稿；留痕结构不给草稿留口子。

import type { PptxElementIndex, PptxElementType } from './element-index';
import { isLayoutCode, type LayoutCode } from './layouts';

export type SourceKind = 'upload_text' | 'reference_ppt' | 'wiki_kb';

export const SOURCE_KINDS: readonly SourceKind[] = [
  'upload_text',
  'reference_ppt',
  'wiki_kb',
] as const;

export interface LayoutAssignment {
  pageNo: number;
  layout: LayoutCode;
  reason: string;
}

export interface PageSource {
  sourceId: string;
  sourceKind: SourceKind;
  /** 文件内段落序号 / 参考 PPT 页码 / 知识库条目 ID。 */
  locator: string;
}

export interface PageSourceRef {
  pageNo: number;
  sources: PageSource[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function parseJsonArray(value: string | null | undefined): unknown[] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function serializeJobMeta(value: unknown): string {
  return JSON.stringify(value);
}

/** 校验并解析 layout_assignments；结构不对返回 null。 */
export function parseLayoutAssignments(
  value: string | null | undefined
): LayoutAssignment[] | null {
  const arr = parseJsonArray(value);
  if (!arr) return null;
  const out: LayoutAssignment[] = [];
  for (const item of arr) {
    if (!isRecord(item)) return null;
    if (!isPositiveInt(item.pageNo)) return null;
    if (typeof item.layout !== 'string' || !isLayoutCode(item.layout))
      return null;
    if (typeof item.reason !== 'string' || !item.reason.trim()) return null;
    out.push({
      pageNo: item.pageNo,
      layout: item.layout,
      reason: item.reason,
    });
  }
  return out;
}

/** 校验并解析 page_source_refs；结构不对返回 null。 */
export function parsePageSourceRefs(
  value: string | null | undefined
): PageSourceRef[] | null {
  const arr = parseJsonArray(value);
  if (!arr) return null;
  const out: PageSourceRef[] = [];
  for (const item of arr) {
    if (!isRecord(item)) return null;
    if (!isPositiveInt(item.pageNo)) return null;
    if (!Array.isArray(item.sources)) return null;
    const sources: PageSource[] = [];
    for (const s of item.sources as unknown[]) {
      if (!isRecord(s)) return null;
      if (typeof s.sourceId !== 'string' || !s.sourceId.trim()) return null;
      if (
        typeof s.sourceKind !== 'string' ||
        !(SOURCE_KINDS as readonly string[]).includes(s.sourceKind)
      )
        return null;
      if (typeof s.locator !== 'string' || !s.locator.trim()) return null;
      sources.push({
        sourceId: s.sourceId,
        sourceKind: s.sourceKind as SourceKind,
        locator: s.locator,
      });
    }
    out.push({ pageNo: item.pageNo, sources });
  }
  return out;
}

const ELEMENT_TYPES: readonly string[] = [
  'text',
  'shape',
  'image',
  'chart',
  'other',
] as const;

const ELEMENT_ID_RE = /^el-p\d+-\d+$/;

/** 校验并解析 element_index；结构不对或 ID 重复返回 null。 */
export function parseElementIndex(
  value: string | null | undefined
): PptxElementIndex | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return null;
  if (!Array.isArray(parsed.pages)) return null;
  const seen = new Set<string>();
  const pages: PptxElementIndex['pages'] = [];
  for (const page of parsed.pages as unknown[]) {
    if (!isRecord(page) || !isPositiveInt(page.pageNo)) return null;
    if (!Array.isArray(page.elements)) return null;
    const elements: PptxElementIndex['pages'][number]['elements'] = [];
    for (const el of page.elements as unknown[]) {
      if (!isRecord(el)) return null;
      if (typeof el.elementId !== 'string' || !ELEMENT_ID_RE.test(el.elementId))
        return null;
      if (seen.has(el.elementId)) return null;
      seen.add(el.elementId);
      if (el.pageNo !== page.pageNo) return null;
      if (typeof el.type !== 'string' || !ELEMENT_TYPES.includes(el.type))
        return null;
      if (typeof el.name !== 'string' || typeof el.text !== 'string')
        return null;
      if (el.slotId !== null && typeof el.slotId !== 'string') return null;
      elements.push({
        elementId: el.elementId,
        pageNo: page.pageNo,
        type: el.type as PptxElementType,
        name: el.name,
        text: el.text,
        slotId: el.slotId as string | null,
      });
    }
    pages.push({ pageNo: page.pageNo, elements });
  }
  return { version: 1, pages };
}
