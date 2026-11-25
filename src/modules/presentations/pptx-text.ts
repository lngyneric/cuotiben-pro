// 参考 PPT（PPTX）文本与主题色抽取 —— 阶段 1 内容源。
//
// PPTX 是 zip 包：逐页文字在 ppt/slides/slideN.xml 的 <a:t> 里，主题色
// 在 ppt/theme/theme1.xml 的 <a:clrScheme> 里。只读文本与色值，不改文件。
// 不是合法 PPTX（zip 解不开、无 slide）时返回 null，由调用方按“抽取失败”
// 明确报错，不编内容。

import { readZipEntries } from './element-index';

export interface PptxSlideText {
  pageNo: number;
  /** 本页第一行有字文本（常为标题），没有时为空。 */
  title: string;
  /** 本页全部 <a:t> 文本按段落拼起。 */
  text: string;
}

export interface PptxExtract {
  slides: PptxSlideText[];
  /** 主题色（theme1.xml clrScheme 里的 srgbClr，按 accent1–6 + dk/lt 顺序去重）。 */
  themeColors: string[];
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 一页 slide XML → 段落文本列表（每 <a:p> 一段）。 */
function slideParagraphs(xml: string): string[] {
  const out: string[] = [];
  const pRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  let p: RegExpExecArray | null;
  while ((p = pRe.exec(xml)) !== null) {
    const runs: string[] = [];
    const tRe = /<a:t>([^<]*)<\/a:t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(p[1])) !== null) runs.push(decodeXmlEntities(t[1]));
    const line = runs.join('').trim();
    if (line) out.push(line);
  }
  return out;
}

function themeColorsFrom(xml: string): string[] {
  const colors: string[] = [];
  const scheme = /<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(xml);
  const body = scheme ? scheme[1] : xml;
  const re = /<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const hex = `#${m[1].toUpperCase()}`;
    if (!colors.includes(hex)) colors.push(hex);
  }
  return colors;
}

export function extractPptxSlides(bytes: Buffer): PptxExtract | null {
  const entries = readZipEntries(bytes);
  if (!entries) return null;
  const slides: PptxSlideText[] = [];
  for (const entry of entries) {
    const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(entry.name);
    if (!m) continue;
    const paras = slideParagraphs(entry.data.toString('utf-8'));
    slides.push({
      pageNo: Number(m[1]),
      title: paras[0] ?? '',
      text: paras.join('\n'),
    });
  }
  if (slides.length === 0) return null;
  slides.sort((a, b) => a.pageNo - b.pageNo);
  let themeColors: string[] = [];
  for (const entry of entries) {
    if (/^ppt\/theme\/theme\d+\.xml$/.test(entry.name)) {
      themeColors = themeColorsFrom(entry.data.toString('utf-8'));
      if (themeColors.length > 0) break;
    }
  }
  return { slides, themeColors };
}
