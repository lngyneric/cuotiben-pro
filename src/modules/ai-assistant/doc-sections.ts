// AI 学习助手：已上传 HTML 文档的 section 粒度解析（纯函数，不读库、不读配置）。
//
// 入社培训 HTML（如《入社培训 · 新人第一周》）由若干
// <section class="static-doc" id="p00" …> 组成，每篇一个 h2 标题。
// 本模块只做解析：把 HTML 文件解析成 section 条目（标题 + 纯文本 +
// 站内外的相关链接），供路由层做关键词粗筛与 Jev 语义打分。
// 索引的加载、缓存与落盘见 doc-index.ts；Jev 打分与回答见 service.ts。
//
// 解析不用 DOM（零新依赖，沿用 blog-html scrubber 的正则做法）：
// 只认 <section class="static-doc" id="…">，其余标签一律剥掉；每篇的
// 正文取第一个 h2 作标题；<div class="pager">（上一篇/下一篇导航）
// 会污染关键词匹配，解析时去掉；<a href> 的链接单独抽出来，不进正文。

export interface DocSection extends ParsedSection {
  /** 所属 HTML 文件的 key（如 html/xxx.html）与标题。 */
  docKey: string;
  docTitle: string;
}

/** 把一批 HTML 文件（含 key、标题、正文）解析成 section 条目。 */
export function buildDocSections(
  files: { key: string; title: string; content: string }[]
): DocSection[] {
  const out: DocSection[] = [];
  for (const f of files) {
    for (const s of parseHtmlSections(f.content)) {
      out.push({ ...s, docKey: f.key, docTitle: f.title });
    }
  }
  return out;
}

export interface DocSectionLink {
  text: string;
  href: string;
}

export interface ParsedSection {
  sectionId: string;
  sectionTitle: string;
  text: string;
  links: DocSectionLink[];
}

const STATIC_SECTION_OPEN_RE =
  /<section\s+class="static-doc"\s+id="([^"]+)"[^>]*>/g;
const H2_RE = /<h2[^>]*>([\s\S]*?)<\/h2>/i;
const PAGER_RE = /<div\s+class="pager"[\s\S]*?<\/div>/gi;
const STYLE_RE = /<style[^>]*>[\s\S]*?<\/style\s*>/gi;
const LINK_RE = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/gi;
const TAG_RE = /<[^>]+>/g;

function stripTags(html: string): string {
  return html.replace(TAG_RE, ' ');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const n = parseInt(hex, 16);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '';
    });
}

function cleanText(html: string): string {
  return decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();
}

/**
 * 把一份已上传 HTML 解析成 static-doc section 列表。
 * 非 static-doc 的 <section>（每篇内部的小节）不单独成条；
 * 没有 static-doc section 的 HTML 返回空数组。
 */
export function parseHtmlSections(html: string): ParsedSection[] {
  const opens = [...(html || '').matchAll(STATIC_SECTION_OPEN_RE)];
  const sections: ParsedSection[] = [];
  for (let i = 0; i < opens.length; i++) {
    const open = opens[i];
    const sectionId = open[1];
    const start = (open.index ?? 0) + open[0].length;
    const end = opens[i + 1]?.index ?? html.length;
    let inner = html.slice(start, end);
    // 每篇末尾的 </section> 是本篇的闭合标签，不进正文。
    inner = inner.replace(/<\/section\s*>\s*$/, '');
    const h2 = H2_RE.exec(inner);
    const sectionTitle = h2 ? cleanText(h2[1]) : sectionId;
    const links: DocSectionLink[] = [];
    for (const m of inner.matchAll(LINK_RE)) {
      const href = decodeEntities(m[1]).trim();
      // 站内锚点（上一篇/下一篇）不是外部来源，不收。
      if (!href || href.startsWith('#')) continue;
      const text = cleanText(m[2]);
      if (!links.some((l) => l.href === href)) {
        links.push({ text, href });
      }
    }
    const body = inner.replace(PAGER_RE, '').replace(STYLE_RE, '');
    sections.push({
      sectionId,
      sectionTitle,
      text: cleanText(body),
      links,
    });
  }
  return sections;
}
