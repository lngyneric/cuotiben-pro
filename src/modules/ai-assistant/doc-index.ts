// AI 学习助手文档索引的加载与持久化。
//
// 索引是派生数据（HTML 文件内容 + 元数据的纯函数），不进关系表：
// schema.ts 由模板生成（scripts/db-setup.mjs），加表要改模板、重新生成、
// 再对线上库做 drizzle-kit push/migrate——为一个派生索引太重。
// 所以索引以 data/doc-index.json 落盘（local 后端），内存里再缓存一份。
//
// 新鲜度不靠 hook 上传/删除路由：每次加载先拿 listBlogHtml() 的
// (key, sha256, visibility, keywords) 指纹比对，指纹变了就重建——上传、
// 删除、覆盖重传、改分类/关键词都会变指纹，索引自动跟上；新上传的
// 文件同样进索引。
// R2 后端（Cloudflare Workers）没有本地磁盘：跳过落盘，只用内存缓存。
// 索引只收 visibility 不是 self 的文件（self 只对上传者本人和管理员
// 开放，不能进共享索引）；public/all 都是登录用户可见，助手本来就
// 要求登录，所以直接收。
//
// 任何一步失败（读库、读盘、写盘）都不抛错到调用方：磁盘缓存读不到
// 就重建，写盘失败只影响下次启动速度——索引本身永远能从源文件重建。

import { envConfigs } from '@/config';
import {
  blogHtmlUrl,
  getBlogHtml,
  listBlogHtml,
} from '@/modules/blog-html/storage';

import { buildDocSections, type DocSection } from './doc-sections';
import { splitKeywordList, type DocCandidate } from './service';

export type { DocSection } from './doc-sections';

export const DOC_INDEX_FILENAME = 'doc-index.json';

export interface DocIndexFile {
  version: 1;
  fingerprint: string;
  sections: DocSection[];
}

export function computeDocFingerprint(
  items: {
    key: string;
    sha256: string;
    visibility: string;
    keywords?: string;
  }[]
): string {
  return items
    .map((i) => `${i.key}|${i.sha256}|${i.visibility}|${i.keywords ?? ''}`)
    .sort()
    .join('\n');
}

/** 文档 section 的公开链接：HTML 渲染地址 + #pXX 锚点。 */
export function docSectionUrl(section: DocCandidate): string {
  return `${blogHtmlUrl(section.docKey)}#${section.sectionId}`;
}

let cached: { fingerprint: string; sections: DocSection[] } | null = null;

async function docIndexPath(): Promise<string | null> {
  try {
    if (typeof process === 'undefined' || !process.cwd) return null;
    const { resolve, dirname } = await import('node:path');
    const dir = envConfigs.blog_html_dir || './data/blog-html';
    return resolve(dirname(resolve(dir)), DOC_INDEX_FILENAME);
  } catch {
    return null;
  }
}

async function readDocIndexFile(): Promise<DocIndexFile | null> {
  const path = await docIndexPath();
  if (!path) return null;
  try {
    const { readFile } = await import('node:fs/promises');
    const parsed = JSON.parse(await readFile(path, 'utf8')) as DocIndexFile;
    if (
      parsed?.version !== 1 ||
      typeof parsed.fingerprint !== 'string' ||
      !Array.isArray(parsed.sections)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeDocIndexFile(index: DocIndexFile): Promise<void> {
  const path = await docIndexPath();
  if (!path) return;
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(index), 'utf8');
}

/**
 * 读文档索引（section 粒度）。内存缓存 + 磁盘 JSON 缓存 + 源文件重建
 * 三层：指纹不变直接用缓存；变了就从 listBlogHtml/getBlogHtml 重建。
 * 返回 [] 时调用方按“无文档”处理，不阻塞课程链路。
 */
export async function loadDocIndex(): Promise<DocSection[]> {
  const items = await listBlogHtml();
  const visible = items.filter((i) => i.visibility !== 'self');
  const fingerprint = computeDocFingerprint(visible);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.sections;
  }
  const disk = await readDocIndexFile();
  if (disk && disk.fingerprint === fingerprint) {
    cached = { fingerprint, sections: disk.sections };
    return disk.sections;
  }
  const sections: DocSection[] = [];
  for (const item of visible) {
    const got = await getBlogHtml(item.key).catch(() => null);
    if (!got) continue;
    // 关键词挂到该文件的每个 section 上，供文档打分用；改关键词会变
    // 指纹，下次加载自动重建。
    const keywords = splitKeywordList(got.meta.keywords);
    sections.push(
      ...buildDocSections([
        { key: item.key, title: item.title || item.key, content: got.content },
      ]).map((s) => ({ ...s, keywords }))
    );
  }
  cached = { fingerprint, sections };
  await writeDocIndexFile({ version: 1, fingerprint, sections }).catch(
    () => undefined
  );
  return sections;
}

/** 仅供测试与运维排障：清掉内存缓存，下次加载重新比对指纹。 */
export function clearDocIndexCache(): void {
  cached = null;
}
