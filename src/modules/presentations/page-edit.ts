// 单页编辑 —— 阶段 2 能力三（实施清单能力三）。
//
// 纯函数层：只对 PPTX 字节做手术，不碰数据库、不调 Presenton、不读图片
// 库（换图的图片字节由 service 层先按 image_id 解析好再传进来）。
// 关键不变量：
// - 只改目标 slide 的 XML（+ 换图时新增的 media/rels/Content_Types 条
//   目），其余 slide 的 local 记录逐字节原样保留（见 element-index.ts
//   的 replaceZipEntry / addZipEntries），其余页解压后内容不变。
// - 元素定位只认 element_id（el-p<页>-<序号>，即页内第 N 个形状），
//   不靠猜坐标；口述“移到右栏”这类相对描述由调用方先映射成 slotId /
//   rectIn 再传进来，本层只接受明确的矩形。
// - set_text 只改文字，不动位置、字号与颜色；set_style 的颜色只认主题
//   色板，或调用方明确声明用户给出的色值（explicitColor），不自创配色。
// - move/resize 越界时直接报错，不静默裁剪；删图后旧 media 残留为孤儿
//   条目（PowerPoint 可正常打开），不静默删文件。

import {
  addZipEntries,
  buildElementIndex,
  elementIdFor,
  hasStampedElementIds,
  readZipEntries,
  readZipEntry,
  replaceZipEntry,
  type PptxElementIndex,
  type PptxElementType,
} from './element-index';
import { PresentonError } from './errors';
import {
  allSlots,
  PPT_SLIDE_SIZE_IN,
  PPT_THEME_COLORS,
  type LayoutCode,
} from './layouts';

export interface RectIn {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PageEditOp =
  | { op: 'set_text'; elementId: string; text: string }
  | {
      op: 'set_style';
      elementId: string;
      color?: string;
      /** 调用方声明：该色值是用户明确给出的（非主题色时必填）。 */
      explicitColor?: boolean;
      fontSizePt?: number;
      bold?: boolean;
      align?: 'left' | 'center' | 'right';
    }
  | {
      op: 'move';
      elementId: string;
      /** 目标矩形（全部字段）；slotId 由 service 层先解析成 rectIn。 */
      rectIn: RectIn;
    }
  | {
      op: 'resize';
      elementId: string;
      rectIn: RectIn;
    }
  | {
      op: 'replace_image';
      elementId: string;
      image: {
        bytes: Buffer;
        ext: 'png' | 'jpg' | 'gif' | 'webp';
        width: number | null;
        height: number | null;
      };
      /** 换图同时移到该矩形（槽位已由 service 层解析）；不给则保持原位。 */
      rectIn?: RectIn;
    }
  | {
      op: 'add_element';
      kind: 'text' | 'shape';
      text?: string;
      rectIn: RectIn;
      color?: string;
      explicitColor?: boolean;
      fontSizePt?: number;
      bold?: boolean;
    }
  | { op: 'delete_element'; elementId: string };

export interface PlannedChange {
  op: string;
  elementId: string | null;
  summary: string;
}

export interface PageElementView {
  elementId: string;
  type: PptxElementType;
  name: string;
  text: string;
  slotId: string | null;
  /** 英寸几何（无 xfrm 时为 null）。 */
  geomIn: RectIn | null;
}

const EMU_PER_INCH = 914400;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const THEME_HEX = new Set(
  Object.values(PPT_THEME_COLORS).map((c) => c.toUpperCase())
);

function fail(message: string): never {
  throw new PresentonError('invalid_input', message);
}

function escapeXml(s: string): string {
  return s
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 校验颜色：主题色直接认；非主题色须调用方声明是用户明确给出的。 */
export function resolveStyleColor(
  color: string | undefined,
  explicitColor: boolean | undefined
): string | null {
  if (color === undefined) return null;
  if (!HEX_COLOR_RE.test(color))
    fail(`颜色值「${color}」不是合法的 #RRGGBB 色值`);
  const hex = color.toUpperCase();
  if (THEME_HEX.has(hex)) return hex.slice(1);
  if (explicitColor === true) return hex.slice(1);
  fail(
    `颜色 ${hex} 不在主题色板中：只有用户明确给出的色值才能使用（请确认用户确实指定了该色值），不自创配色`
  );
}

function checkBounds(rect: RectIn, what: string): void {
  const eps = 0.001;
  if (
    !(rect.width > 0) ||
    !(rect.height > 0) ||
    rect.x < -eps ||
    rect.y < -eps ||
    rect.x + rect.width > PPT_SLIDE_SIZE_IN.width + eps ||
    rect.y + rect.height > PPT_SLIDE_SIZE_IN.height + eps
  )
    fail(
      `${what}越界：矩形 x=${rect.x}in, y=${rect.y}in, ${rect.width}×${rect.height}in 超出页面 ${PPT_SLIDE_SIZE_IN.width}×${PPT_SLIDE_SIZE_IN.height}in，已拒绝，未改动文件`
    );
}

function isRectIn(value: unknown): value is RectIn {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.x === 'number' &&
    typeof r.y === 'number' &&
    typeof r.width === 'number' &&
    typeof r.height === 'number' &&
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height)
  );
}

export function validateRectIn(value: unknown, what: string): RectIn {
  if (!isRectIn(value))
    fail(`${what}须给出明确矩形 {x, y, width, height}（英寸）`);
  checkBounds(value, what);
  return value;
}

// ─── 形状扫描 ───────────────────────────────────────────────────────────────

interface ShapeSpan {
  ordinal: number;
  kind: 'sp' | 'pic' | 'frame';
  start: number;
  end: number;
  name: string;
  text: string;
  /** 是否有 <p:txBody>（无文本框的形状改样式时走填充分支）。 */
  hasText: boolean;
  geomIn: RectIn | null;
}

const SHAPE_START_RE = /<(p:sp|p:pic|p:graphicFrame)>/g;

function shapeText(spanXml: string): string {
  const texts: string[] = [];
  const re = /<a:t>([^<]*)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(spanXml)) !== null) texts.push(m[1]);
  return texts.join('');
}

function shapeGeom(spanXml: string): RectIn | null {
  const off = /<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"\s*\/>/.exec(spanXml);
  const ext = /<a:ext\s+cx="(\d+)"\s+cy="(\d+)"\s*\/>/.exec(spanXml);
  if (!off || !ext) return null;
  return {
    x: Number(off[1]) / EMU_PER_INCH,
    y: Number(off[2]) / EMU_PER_INCH,
    width: Number(ext[1]) / EMU_PER_INCH,
    height: Number(ext[2]) / EMU_PER_INCH,
  };
}

/**
 * 按出现顺序扫描一页的形状 span；顺序与 element-index.ts 的
 * parseSlideShapes 一致（组合容器的 cNvPr 不算形状）。
 */
export function scanShapeSpans(xml: string): ShapeSpan[] {
  const spans: ShapeSpan[] = [];
  let ordinal = 0;
  let m: RegExpExecArray | null;
  SHAPE_START_RE.lastIndex = 0;
  while ((m = SHAPE_START_RE.exec(xml)) !== null) {
    const tag = m[1];
    const kind = tag === 'p:sp' ? 'sp' : tag === 'p:pic' ? 'pic' : 'frame';
    const endTag = `</${tag}>`;
    const endIdx = xml.indexOf(endTag, m.index);
    if (endIdx < 0) fail('页面 XML 结构损坏：形状缺少结束标签');
    const end = endIdx + endTag.length;
    const spanXml = xml.slice(m.index, end);
    // 组合容器 <p:grpSp> 不匹配本正则；这里的每个 span 都是内容形状。
    const nameMatch = /<p:cNvPr\b[^>]*\bname="([^"]*)"/.exec(spanXml);
    ordinal += 1;
    spans.push({
      ordinal,
      kind,
      start: m.index,
      end,
      name: nameMatch ? nameMatch[1] : '',
      text: kind === 'sp' ? shapeText(spanXml) : '',
      hasText: spanXml.includes('<p:txBody>'),
      geomIn: shapeGeom(spanXml),
    });
  }
  return spans;
}

function findSpan(
  spans: ShapeSpan[],
  elementId: string,
  pageNo: number
): ShapeSpan {
  const m = /^el-p(\d+)-(\d+)$/.exec(elementId);
  if (!m || Number(m[1]) !== pageNo)
    fail(`元素 ${elementId} 不在第 ${pageNo} 页`);
  const span = spans.find((s) => s.ordinal === Number(m[2]));
  if (!span) fail(`第 ${pageNo} 页没有元素 ${elementId}`);
  return span;
}

// ─── 各 op 的 XML 改写（只动 span 内文本，返回新 span） ─────────────────────

function setTextInSpan(spanXml: string, text: string): string {
  if (!spanXml.includes('<p:txBody>')) fail('该元素没有文本框，无法改文字');
  const escaped = escapeXml(text);
  const withPreserve =
    /^\s|\s$/.test(text) && text.length > 0 ? ' xml:space="preserve"' : '';
  const runs = [...spanXml.matchAll(/<a:t([^>]*)>([^<]*)<\/a:t>/g)];
  if (runs.length === 0) {
    // 空文本框：在第一个段落里补一个 run。
    const pMatch = /<a:p(\s[^>]*)?>/.exec(spanXml);
    if (!pMatch) fail('该元素的文本框没有段落，无法写入文字');
    const insertAt = pMatch.index + pMatch[0].length;
    return (
      spanXml.slice(0, insertAt) +
      `<a:r><a:t${withPreserve}>${escaped}</a:t></a:r>` +
      spanXml.slice(insertAt)
    );
  }
  let out = spanXml;
  // 从后往前替换，避免偏移错位。
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    const replacement =
      i === 0 ? `<a:t${withPreserve}>${escaped}</a:t>` : '<a:t></a:t>';
    out =
      out.slice(0, run.index) +
      replacement +
      out.slice(run.index + run[0].length);
  }
  return out;
}

function upsertRunPr(
  runXml: string,
  opts: { colorRgb: string | null; fontSizePt?: number; bold?: boolean }
): string {
  // runXml 形如 <a:r>...</a:r>；在 <a:r> 后补/改 <a:rPr>。
  const openEnd = runXml.indexOf('>');
  const head = runXml.slice(0, openEnd + 1);
  const rest = runXml.slice(openEnd + 1);
  const rPrMatch = /^<a:rPr\b[^>]*(\/>|>.*?<\/a:rPr>)/s.exec(rest);
  let rPr: string;
  if (rPrMatch) {
    rPr = rPrMatch[0];
    // 改属性。
    if (opts.fontSizePt !== undefined) {
      const sz = Math.round(opts.fontSizePt * 100);
      rPr = /sz="/.test(rPr)
        ? rPr.replace(/sz="[^"]*"/, `sz="${sz}"`)
        : rPr.replace('<a:rPr', `<a:rPr sz="${sz}"`);
    }
    if (opts.bold !== undefined) {
      rPr = /b="/.test(rPr)
        ? rPr.replace(/b="[^"]*"/, `b="${opts.bold ? 1 : 0}"`)
        : rPr.replace('<a:rPr', `<a:rPr b="${opts.bold ? 1 : 0}"`);
    }
    if (opts.colorRgb !== null) {
      const fill = `<a:solidFill><a:srgbClr val="${opts.colorRgb}"/></a:solidFill>`;
      if (/<a:solidFill>/.test(rPr)) {
        rPr = rPr.replace(/<a:solidFill>.*?<\/a:solidFill>/s, fill);
      } else if (rPr.endsWith('/>')) {
        rPr = rPr.slice(0, -2) + `>${fill}</a:rPr>`;
      } else {
        rPr = rPr.replace(/(<a:rPr\b[^>]*>)/, `$1${fill}`);
      }
    }
    return head + rPr + rest.slice(rPrMatch[0].length);
  }
  const attrs: string[] = [];
  if (opts.fontSizePt !== undefined)
    attrs.push(`sz="${Math.round(opts.fontSizePt * 100)}"`);
  if (opts.bold !== undefined) attrs.push(`b="${opts.bold ? 1 : 0}"`);
  const fill =
    opts.colorRgb !== null
      ? `<a:solidFill><a:srgbClr val="${opts.colorRgb}"/></a:solidFill>`
      : '';
  rPr =
    attrs.length > 0 || fill
      ? `<a:rPr${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>${fill}</a:rPr>`
      : '';
  return head + rPr + rest;
}

function setStyleInSpan(
  spanXml: string,
  kind: 'sp' | 'pic' | 'frame',
  hasText: boolean,
  opts: {
    colorRgb: string | null;
    fontSizePt?: number;
    bold?: boolean;
    align?: 'left' | 'center' | 'right';
  }
): string {
  let out = spanXml;
  const algn =
    opts.align === 'center' ? 'ctr' : opts.align === 'right' ? 'r' : 'l';
  if (kind === 'sp' && hasText) {
    // 文字：逐 run 改 rPr；空文本框（无 run）时不静默跳过——由调用方
    // 先 set_text 再 set_style，或直接报错说明。
    const runRe = /<a:r>.*?<\/a:r>/gs;
    let hasRun = false;
    out = out.replace(runRe, (run) => {
      hasRun = true;
      return upsertRunPr(run, opts);
    });
    if (!hasRun) fail('该文本框是空的：请先写入文字再改样式');
    // 对齐：无 pPr 的段落补一个；有 pPr 的只改 algn 属性（保留自闭合）。
    if (opts.align !== undefined) {
      out = out.replace(/<a:p(\s[^>]*)?>/g, (m, _attrs, offset, full) => {
        const after = (full as string).slice(offset + m.length);
        if (after.startsWith('<a:pPr')) return m;
        return `${m}<a:pPr algn="${algn}"/>`;
      });
      out = out.replace(/<a:pPr([^>]*?)(\/?)>/g, (_m, attrs, selfClose) => {
        const cleaned = (attrs as string).replace(/\s*algn="[^"]*"/, '');
        return `<a:pPr${cleaned} algn="${algn}"${selfClose ? '/' : ''}>`;
      });
    }
    return out;
  }
  // 无文字形状：改形状填充色；字号/加粗/对齐对它无意义。
  if (
    opts.fontSizePt !== undefined ||
    opts.bold !== undefined ||
    opts.align !== undefined
  )
    fail('该元素没有文字，无法改字号、加粗或对齐');
  if (opts.colorRgb === null) return out;
  if (/<a:gradFill>|<a:blipFill>|<a:pattFill>/.test(out))
    fail('该形状已有渐变/图片/图案填充，暂不支持改色');
  const fill = `<a:solidFill><a:srgbClr val="${opts.colorRgb}"/></a:solidFill>`;
  if (/<a:solidFill>/.test(out)) {
    out = out.replace(/<a:solidFill>.*?<\/a:solidFill>/s, fill);
  } else if (/<a:xfrm>/.test(out)) {
    out = out.replace(/(<a:xfrm>.*?<\/a:xfrm>)/s, `$1${fill}`);
  } else if (out.includes('<p:spPr>')) {
    out = out.replace(/<p:spPr>/, `<p:spPr>${fill}`);
  } else {
    fail('该形状没有属性块，无法改色');
  }
  return out;
}

function setGeomInSpan(spanXml: string, rect: RectIn): string {
  const off = `<a:off x="${Math.round(rect.x * EMU_PER_INCH)}" y="${Math.round(rect.y * EMU_PER_INCH)}"/>`;
  const ext = `<a:ext cx="${Math.round(rect.width * EMU_PER_INCH)}" cy="${Math.round(rect.height * EMU_PER_INCH)}"/>`;
  const xfrmRe = /<a:xfrm>.*?<\/a:xfrm>/s;
  if (xfrmRe.test(spanXml)) {
    return spanXml.replace(xfrmRe, `<a:xfrm>${off}${ext}</a:xfrm>`);
  }
  const xfrm = `<a:xfrm>${off}${ext}</a:xfrm>`;
  // sp/pic：插进 <p:spPr> 开头；graphicFrame：插进 nvGraphicFramePr 之后。
  if (spanXml.includes('<p:spPr>'))
    return spanXml.replace(/<p:spPr>/, `<p:spPr>${xfrm}`);
  if (spanXml.includes('<p:spPr/>'))
    return spanXml.replace(/<p:spPr\/>/, `<p:spPr>${xfrm}</p:spPr>`);
  const nvEnd = spanXml.indexOf('</p:nvGraphicFramePr>');
  if (nvEnd >= 0) {
    const at = nvEnd + '</p:nvGraphicFramePr>'.length;
    return spanXml.slice(0, at) + xfrm + spanXml.slice(at);
  }
  fail('该元素没有可写的位置信息');
}

// ─── 拟改动清单（不写文件，供确认环节用） ──────────────────────────────────

export function describePageOps(
  pptx: Buffer,
  pageNo: number,
  ops: PageEditOp[]
): PlannedChange[] {
  const entries = readZipEntries(pptx);
  if (!entries) fail('无法读取 PPTX 文件');
  const slideName = `ppt/slides/slide${pageNo}.xml`;
  const slide = entries.find((e) => e.name === slideName);
  if (!slide) fail(`第 ${pageNo} 页不存在`);
  const spans = scanShapeSpans(slide.data.toString('utf-8'));
  const changes: PlannedChange[] = [];
  for (const op of ops) {
    switch (op.op) {
      case 'set_text': {
        const span = findSpan(spans, op.elementId, pageNo);
        if (typeof op.text !== 'string' || op.text.length > 5000)
          fail('set_text 的文字须为字符串且不超过 5000 字');
        changes.push({
          op: 'set_text',
          elementId: op.elementId,
          summary: `把「${span.text.slice(0, 30) || span.name}」的文字改成「${op.text.slice(0, 30)}${op.text.length > 30 ? '…' : ''}」（位置、字号、颜色不变）`,
        });
        break;
      }
      case 'set_style': {
        const span = findSpan(spans, op.elementId, pageNo);
        const colorRgb = resolveStyleColor(op.color, op.explicitColor);
        if (
          op.fontSizePt !== undefined &&
          (op.fontSizePt < 6 || op.fontSizePt > 100)
        )
          fail('字号须在 6–100pt 之间');
        if (
          (span.kind !== 'sp' || !span.hasText) &&
          (op.fontSizePt !== undefined ||
            op.bold !== undefined ||
            op.align !== undefined)
        )
          fail('该元素没有文字，无法改字号、加粗或对齐');
        const bits: string[] = [];
        if (colorRgb) bits.push(`颜色 #${colorRgb}`);
        if (op.fontSizePt !== undefined) bits.push(`${op.fontSizePt}pt`);
        if (op.bold !== undefined) bits.push(op.bold ? '加粗' : '取消加粗');
        if (op.align !== undefined)
          bits.push(
            `对齐${op.align === 'left' ? '左' : op.align === 'center' ? '居中' : '右'}`
          );
        if (bits.length === 0)
          fail('set_style 至少要改一项（颜色/字号/加粗/对齐）');
        changes.push({
          op: 'set_style',
          elementId: op.elementId,
          summary: `改「${span.text.slice(0, 30) || span.name}」的样式：${bits.join('、')}`,
        });
        break;
      }
      case 'move':
      case 'resize': {
        const span = findSpan(spans, op.elementId, pageNo);
        const rect = validateRectIn(
          op.rectIn,
          op.op === 'move' ? '移动' : '缩放'
        );
        changes.push({
          op: op.op,
          elementId: op.elementId,
          summary: `${op.op === 'move' ? '移动' : '缩放'}「${span.text.slice(0, 30) || span.name}」到 x=${rect.x}in, y=${rect.y}in, ${rect.width}×${rect.height}in`,
        });
        break;
      }
      case 'replace_image': {
        const span = findSpan(spans, op.elementId, pageNo);
        if (span.kind !== 'pic')
          fail(
            `replace_image 只支持图片元素，${op.elementId} 是 ${span.kind === 'sp' ? '文字/形状' : '图表'}`
          );
        if (op.rectIn !== undefined) validateRectIn(op.rectIn, '换图落位');
        changes.push({
          op: 'replace_image',
          elementId: op.elementId,
          summary: `把「${span.name || '图片'}」换成新图（沿用槽位裁切规则，不拉伸）${op.rectIn ? '，并移到指定槽位' : ''}`,
        });
        break;
      }
      case 'add_element': {
        const rect = validateRectIn(op.rectIn, '新增元素');
        resolveStyleColor(op.color, op.explicitColor);
        if (op.kind === 'text' && (typeof op.text !== 'string' || !op.text))
          fail('新增文字元素须给出文字');
        changes.push({
          op: 'add_element',
          elementId: null,
          summary: `在 x=${rect.x}in, y=${rect.y}in, ${rect.width}×${rect.height}in 新增${op.kind === 'text' ? '文字' : '形状'}元素${op.kind === 'text' ? `「${(op.text || '').slice(0, 30)}」` : ''}`,
        });
        break;
      }
      case 'delete_element': {
        const span = findSpan(spans, op.elementId, pageNo);
        changes.push({
          op: 'delete_element',
          elementId: op.elementId,
          summary: `删除元素「${span.text.slice(0, 30) || span.name}」（${span.kind === 'pic' ? '图片' : span.kind === 'frame' ? '图表' : '文字/形状'}），删除后版本号递增、可回退`,
        });
        break;
      }
      default:
        fail(`未知操作：${(op as { op: string }).op}`);
    }
  }
  if (changes.length === 0) fail('操作列表为空');
  if (changes.length > 20) fail('一次最多改 20 个操作');
  return changes;
}

// ─── 执行 ───────────────────────────────────────────────────────────────────

/** 换图：计算 cover-crop 的 srcRect（千分比，l/t/r/b）。 */
function coverCropSrcRect(
  imageWidth: number,
  imageHeight: number,
  target: RectIn
): { l: number; t: number; r: number; b: number } | null {
  if (!imageWidth || !imageHeight || !target.width || !target.height)
    return null;
  const imgAspect = imageWidth / imageHeight;
  const targetAspect = target.width / target.height;
  if (imgAspect > targetAspect) {
    const crop = Math.round((1 - targetAspect / imgAspect) * 100000);
    const half = Math.floor(crop / 2);
    return { l: half, t: 0, r: crop - half, b: 0 };
  }
  const crop = Math.round((1 - imgAspect / targetAspect) * 100000);
  const half = Math.floor(crop / 2);
  return { l: 0, t: half, r: 0, b: crop - half };
}

const MEDIA_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * 对一页应用操作列表，只改该页；返回新 PPTX 字节、拟改动清单与新元素索引。
 * 其余页的 local 记录逐字节保留（replaceZipEntry 的保证）。
 */
export function applyPageOps(
  pptx: Buffer,
  pageNo: number,
  ops: PageEditOp[]
): {
  bytes: Buffer;
  applied: PlannedChange[];
  index: PptxElementIndex;
} {
  const applied = describePageOps(pptx, pageNo, ops);
  const entries = readZipEntries(pptx)!;
  const slideName = `ppt/slides/slide${pageNo}.xml`;
  let slideXml = entries
    .find((e) => e.name === slideName)!
    .data.toString('utf-8');
  // 换图要新增的 zip 内容（先收集，最后一次写盘）。多次换图共用同一份
  // rels / Content_Types 工作副本，逐 op 累积改，避免后一次覆盖前一次。
  const newMedias: Array<{ name: string; data: Buffer }> = [];
  let mediaCounter = 0;
  for (const e of entries) {
    const mm = /^ppt\/media\/image(\d+)\.\w+$/.exec(e.name);
    if (mm) mediaCounter = Math.max(mediaCounter, Number(mm[1]));
  }
  const relsWorking = new Map<string, string>();
  const ctEntry = entries.find((e) => e.name === '[Content_Types].xml');
  let ctWorking: string | null = ctEntry?.data.toString('utf-8') ?? null;
  const ctOriginal = ctWorking;

  for (const op of ops) {
    const spans = scanShapeSpans(slideXml);
    switch (op.op) {
      case 'set_text': {
        const span = findSpan(spans, op.elementId, pageNo);
        const spanXml = slideXml.slice(span.start, span.end);
        slideXml =
          slideXml.slice(0, span.start) +
          setTextInSpan(spanXml, op.text) +
          slideXml.slice(span.end);
        break;
      }
      case 'set_style': {
        const span = findSpan(spans, op.elementId, pageNo);
        const spanXml = slideXml.slice(span.start, span.end);
        slideXml =
          slideXml.slice(0, span.start) +
          setStyleInSpan(spanXml, span.kind, span.hasText, {
            colorRgb: resolveStyleColor(op.color, op.explicitColor),
            fontSizePt: op.fontSizePt,
            bold: op.bold,
            align: op.align,
          }) +
          slideXml.slice(span.end);
        break;
      }
      case 'move':
      case 'resize': {
        const span = findSpan(spans, op.elementId, pageNo);
        const spanXml = slideXml.slice(span.start, span.end);
        slideXml =
          slideXml.slice(0, span.start) +
          setGeomInSpan(spanXml, op.rectIn) +
          slideXml.slice(span.end);
        break;
      }
      case 'replace_image': {
        const span = findSpan(spans, op.elementId, pageNo);
        let spanXml = slideXml.slice(span.start, span.end);
        const blipMatch =
          /<a:blip\b[^>]*\br:embed="(rId\d+)"[^>]*(\/>|>.*?<\/a:blip>)/s.exec(
            spanXml
          );
        if (!blipMatch) fail(`图片元素 ${op.elementId} 没有可替换的图片引用`);
        const rid = blipMatch[1];
        // 新 media 文件名：取未用的最大序号 +1（同一次调用内多次换图递增）。
        mediaCounter += 1;
        const mediaName = `ppt/media/image${mediaCounter}.${op.image.ext}`;
        newMedias.push({ name: mediaName, data: op.image.bytes });
        // rels：把该 rId 的 Target 指到新 media；rels 文件不存在则新建。
        const relsName = `ppt/slides/_rels/slide${pageNo}.xml.rels`;
        let relsXml =
          relsWorking.get(relsName) ??
          entries.find((e) => e.name === relsName)?.data.toString('utf-8') ??
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
        const target = `../media/image${mediaCounter}.${op.image.ext}`;
        if (relsXml.includes(`Id="${rid}"`)) {
          relsXml = relsXml.replace(
            new RegExp(
              `(<Relationship\\b[^>]*\\bId="${rid}"[^>]*\\bTarget=")[^"]*(")`
            ),
            `$1${target}$2`
          );
        } else {
          // rId 不在 rels 里：补一条新关系，并把 blip 的 r:embed 指过去。
          let maxRid = 0;
          for (const rm of relsXml.matchAll(/Id="rId(\d+)"/g))
            maxRid = Math.max(maxRid, Number(rm[1]));
          const newRid = `rId${maxRid + 1}`;
          relsXml = relsXml.replace(
            '</Relationships>',
            `<Relationship Id="${newRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/></Relationships>`
          );
          spanXml = spanXml.replace(`r:embed="${rid}"`, `r:embed="${newRid}"`);
        }
        relsWorking.set(relsName, relsXml);
        // Content_Types：缺该扩展的 Default 时补一条。
        if (
          ctWorking !== null &&
          !ctWorking.includes(`Extension="${op.image.ext}"`)
        ) {
          ctWorking = ctWorking.replace(
            '</Types>',
            `<Default Extension="${op.image.ext}" ContentType="${MEDIA_CONTENT_TYPES[op.image.ext]}"/></Types>`
          );
        }
        // cover-crop：按目标矩形（指定槽位或原位）算 srcRect。
        const targetRect = op.rectIn ?? span.geomIn;
        if (targetRect && op.image.width && op.image.height) {
          const crop = coverCropSrcRect(
            op.image.width,
            op.image.height,
            targetRect
          );
          if (crop) {
            const srcRect = `<a:srcRect l="${crop.l}" t="${crop.t}" r="${crop.r}" b="${crop.b}"/>`;
            if (/<a:srcRect\b[^>]*\/>/.test(spanXml)) {
              spanXml = spanXml.replace(/<a:srcRect\b[^>]*\/>/, srcRect);
            } else {
              spanXml = spanXml.replace(
                /(<a:blip\b[^>]*(\/>|>.*?<\/a:blip>))/s,
                `$1${srcRect}`
              );
            }
          }
        }
        if (op.rectIn) spanXml = setGeomInSpan(spanXml, op.rectIn);
        slideXml =
          slideXml.slice(0, span.start) + spanXml + slideXml.slice(span.end);
        break;
      }
      case 'add_element': {
        const colorRgb = resolveStyleColor(op.color, op.explicitColor);
        let maxId = 0;
        for (const m of slideXml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g))
          maxId = Math.max(maxId, Number(m[1]));
        const newOrdinal = spans.length + 1;
        const elementId = elementIdFor(pageNo, newOrdinal);
        const off = `<a:off x="${Math.round(op.rectIn.x * EMU_PER_INCH)}" y="${Math.round(op.rectIn.y * EMU_PER_INCH)}"/>`;
        const ext = `<a:ext cx="${Math.round(op.rectIn.width * EMU_PER_INCH)}" cy="${Math.round(op.rectIn.height * EMU_PER_INCH)}"/>`;
        const rPrAttrs: string[] = [];
        if (op.fontSizePt !== undefined)
          rPrAttrs.push(`sz="${Math.round(op.fontSizePt * 100)}"`);
        if (op.bold !== undefined) rPrAttrs.push(`b="${op.bold ? 1 : 0}"`);
        const fill =
          colorRgb !== null
            ? `<a:solidFill><a:srgbClr val="${colorRgb}"/></a:solidFill>`
            : '';
        const rPr =
          rPrAttrs.length > 0 || fill
            ? `<a:rPr${rPrAttrs.length > 0 ? ` ${rPrAttrs.join(' ')}` : ''}>${fill}</a:rPr>`
            : '';
        let shape: string;
        if (op.kind === 'text') {
          shape =
            `<p:sp><p:nvSpPr><p:cNvPr id="${maxId + 1}" name="${elementId}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvSpPr>` +
            `<p:spPr><a:xfrm>${off}${ext}</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
            `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:r>${rPr}<a:t>${escapeXml(op.text || '')}</a:t></a:r></a:p></p:txBody></p:sp>`;
        } else {
          const shapeFill =
            colorRgb !== null
              ? `<a:solidFill><a:srgbClr val="${colorRgb}"/></a:solidFill>`
              : `<a:solidFill><a:srgbClr val="${PPT_THEME_COLORS.dividerGrayBlue.slice(1)}"/></a:solidFill>`;
          shape =
            `<p:sp><p:nvSpPr><p:cNvPr id="${maxId + 1}" name="${elementId}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvSpPr>` +
            `<p:spPr><a:xfrm>${off}${ext}</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${shapeFill}</p:spPr></p:sp>`;
        }
        const closeIdx = slideXml.indexOf('</p:spTree>');
        if (closeIdx < 0) fail('页面 XML 结构损坏：缺少 spTree 结束标签');
        slideXml =
          slideXml.slice(0, closeIdx) + shape + slideXml.slice(closeIdx);
        break;
      }
      case 'delete_element': {
        const span = findSpan(spans, op.elementId, pageNo);
        slideXml = slideXml.slice(0, span.start) + slideXml.slice(span.end);
        break;
      }
    }
  }

  let bytes: Buffer | null = replaceZipEntry(
    pptx,
    slideName,
    Buffer.from(slideXml, 'utf-8')
  );
  if (!bytes)
    throw new PresentonError(
      'presenton_error',
      '单页重写失败：无法写回 PPTX 文件'
    );
  if (relsWorking.size > 0) {
    const additions: Array<{ name: string; data: Buffer }> = [];
    for (const [relsName, relsXml] of relsWorking) {
      const relsEntry = readZipEntry(bytes, relsName);
      if (relsEntry === null) {
        additions.push({ name: relsName, data: Buffer.from(relsXml, 'utf-8') });
      } else {
        const replaced = replaceZipEntry(
          bytes,
          relsName,
          Buffer.from(relsXml, 'utf-8')
        );
        if (!replaced)
          throw new PresentonError(
            'presenton_error',
            '单页重写失败：无法写回图片关系文件'
          );
        bytes = replaced;
      }
    }
    if (additions.length > 0) {
      const added = addZipEntries(bytes, additions);
      if (!added)
        throw new PresentonError(
          'presenton_error',
          '单页重写失败：无法写回图片关系文件'
        );
      bytes = added;
    }
  }
  if (ctWorking !== null && ctWorking !== ctOriginal) {
    const replaced = replaceZipEntry(
      bytes,
      '[Content_Types].xml',
      Buffer.from(ctWorking, 'utf-8')
    );
    if (!replaced)
      throw new PresentonError(
        'presenton_error',
        '单页重写失败：无法写回 Content_Types'
      );
    bytes = replaced;
  }
  if (newMedias.length > 0) {
    const added = addZipEntries(bytes, newMedias);
    if (!added)
      throw new PresentonError(
        'presenton_error',
        '单页重写失败：无法写入新图片'
      );
    bytes = added;
  }
  const index = buildElementIndex(bytes);
  if (!index)
    throw new PresentonError('presenton_error', '单页重写后无法读回元素索引');
  return { bytes, applied, index };
}

// ─── 取页元素（page_get 用） ─────────────────────────────────────────────────

/**
 * 取一页的元素清单：element_id、类型、当前文字/属性、所在槽位（按几何
 * 中心落在哪个版式槽位里判定；无版式记录或落不进任何槽位时为 null）。
 * 未盖章的旧稿也能列出（ID 为按顺序算出的），但 editable=false。
 */
export function getPageElements(
  pptx: Buffer,
  pageNo: number,
  layoutCode?: LayoutCode | null
): {
  pageNo: number;
  elements: PageElementView[];
  editable: boolean;
} {
  const stamped = hasStampedElementIds(pptx);
  if (stamped === null)
    throw new PresentonError(
      'presenton_error',
      '无法读取 PPTX 文件：不是合法的演示文稿'
    );
  const index = buildElementIndex(pptx);
  if (!index)
    throw new PresentonError(
      'presenton_error',
      '无法读取 PPTX 文件：没有可列出的页面'
    );
  const page = index.pages.find((p) => p.pageNo === pageNo);
  if (!page) fail(`第 ${pageNo} 页不存在`);
  const entries = readZipEntries(pptx);
  const slideName = `ppt/slides/slide${pageNo}.xml`;
  const slide = entries?.find((e) => e.name === slideName);
  const spans = slide ? scanShapeSpans(slide.data.toString('utf-8')) : [];
  const geomByOrdinal = new Map(spans.map((s) => [s.ordinal, s.geomIn]));
  const slots = layoutCode ? allSlots(layoutCode) : [];
  const elements: PageElementView[] = page.elements.map((el) => {
    const geomIn =
      geomByOrdinal.get(
        Number(/^el-p\d+-(\d+)$/.exec(el.elementId)?.[1] ?? 0)
      ) ?? null;
    let slotId: string | null = null;
    if (geomIn && slots.length > 0) {
      const cx = geomIn.x + geomIn.width / 2;
      const cy = geomIn.y + geomIn.height / 2;
      const containing = slots
        .filter(
          (s) =>
            cx >= s.rectIn.x &&
            cx <= s.rectIn.x + s.rectIn.width &&
            cy >= s.rectIn.y &&
            cy <= s.rectIn.y + s.rectIn.height
        )
        .sort(
          (a, b) =>
            a.rectIn.width * a.rectIn.height - b.rectIn.width * b.rectIn.height
        );
      slotId = containing[0]?.id ?? null;
    }
    return {
      elementId: el.elementId,
      type: el.type,
      name: el.name,
      text: el.text,
      slotId,
      geomIn,
    };
  });
  return { pageNo, elements, editable: stamped };
}
