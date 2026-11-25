// 图片库 —— 阶段 1 能力一（P1）。
//
// 【实施前置核实，2026-11-25 实查代码】
// - blog 文章配图：post.image 是一个 URL 字符串，无独立图片表。上传走
//   src/routes/api/storage/upload-image.ts：R2 已配置时对象 key 为
//   `<md5>.<ext>`（R2 uploadPath 默认 `uploads`），公开 URL 经
//   storage.getPublicUrl 取；未配 R2 时落本地 public/uploads/<md5>.<ext>，
//   URL 为 /uploads/<md5>.<ext>。可见性无 per-image 规则，继承文章本身：
//   已发布文章的配图对已登录用户可见，草稿/归档文章的配图不可见。
// - /wiki/html 上传图：blog-html 只存 .html 文件（本地：BLOG_HTML_DIR
//   磁盘 + blog_html_file 表；R2：html/ 前缀对象，见
//   src/modules/blog-html/storage.ts），没有独立图片存储；页面里的图是
//   HTML 内 <img src> 引用的地址。所以 wiki_html 图片 = 从调用人可见的
//   html 文档内容里解析出的 <img src>，可见性沿用 canViewBlogHtml
//   （visibility self 仅上传者本人与管理员可见）。
// - 流程内上传/粘贴：不另建存储，落 wiki 现有文件存储（同 upload-image
//   路由：R2 或 public/uploads），元数据进 presentation_image 新表。
// - 取图：/uploads/ 路径读本地磁盘；R2 公开 URL 与本站同源 URL 走 fetch
//   （10 秒超时）；其它外域 URL 不取（防 SSRF），记为“图不可用”进缺图。
// - v1 不做文生图、不接外部图库、不直拉 SharePoint 图片、不做图片编辑。
//
// 跨模块 import 的例外（与 service.ts 的 config/notify 同款）：post 表
// 直接查；blog-html 的 list/get/可见性复用 blog-html 模块；文件落盘复用
// storage 模块的 getStorage（R2）与 upload-image 路由同款本地 fallback。

import { and, eq, like, or } from 'drizzle-orm';

import { db } from '@/core/db';
import { envConfigs } from '@/config';
import {
  post,
  presentationImage,
  type PresentationImage,
} from '@/config/db/schema';
import {
  MAX_ATTACHMENT_FILES,
  MAX_ATTACHMENT_IMAGES,
  MAX_FILE_DECODED_BYTES,
  MAX_TOTAL_BASE64_CHARS,
} from '@/modules/ai-assistant/attachments';
import { canViewBlogHtml } from '@/modules/blog-html/service';
import { getBlogHtml, listBlogHtml } from '@/modules/blog-html/storage';
import { getAllConfigs } from '@/modules/config/service';
import { getStorage } from '@/modules/storage/service';
import { getUuid, md5 } from '@/lib/hash';

import { PresentonError } from './errors';
import type { ImageAssignment } from './job-meta';
import { allSlots } from './layouts';
import type { OutlinePage } from './sources';

export type { ImageAssignment } from './job-meta';

export const MAX_IMAGES_PER_TASK = MAX_ATTACHMENT_FILES; // 5
export const MAX_PASTE_IMAGES_PER_TASK = MAX_ATTACHMENT_IMAGES; // 3

export type ImageSourceType = 'wiki_blog' | 'wiki_html' | 'upload' | 'paste';

export const IMAGE_SOURCE_TYPES: readonly ImageSourceType[] = [
  'wiki_blog',
  'wiki_html',
  'upload',
  'paste',
] as const;

const IMAGE_EXTS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

export interface ImageOwner {
  userId: string;
  tokenId?: string | null;
}

export interface ImageViewer extends ImageOwner {
  isAdmin: boolean;
}

/** 解析 PNG/JPEG/GIF/WebP 的宽高（纯函数，不依赖图片库）。 */
export function parseImageDimensions(
  buf: Buffer,
  ext: string
): { width: number; height: number } | null {
  try {
    if (ext === 'png') {
      if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (ext === 'gif') {
      if (buf.length < 10) return null;
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (ext === 'jpg' || ext === 'jpeg') {
      let p = 2;
      while (p + 9 < buf.length) {
        if (buf[p] !== 0xff) return null;
        const marker = buf[p + 1];
        const len = buf.readUInt16BE(p + 2);
        if (marker >= 0xc0 && marker <= 0xc3) {
          return {
            height: buf.readUInt16BE(p + 5),
            width: buf.readUInt16BE(p + 7),
          };
        }
        p += 2 + len;
      }
      return null;
    }
    if (ext === 'webp') {
      if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF')
        return null;
      if (buf.toString('ascii', 8, 12) !== 'WEBP') return null;
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X' && buf.length >= 30) {
        return {
          width: buf.readUIntLE(24, 3) + 1,
          height: buf.readUIntLE(27, 3) + 1,
        };
      }
      if (chunk === 'VP8L' && buf.length >= 25) {
        const v = buf.readUInt32LE(21);
        return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8 ' && buf.length >= 30) {
        const v = buf.readUInt16LE(26);
        return { width: v & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

function decodeBase64Strict(base64: string, name: string): Buffer {
  const compact = base64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0)
    throw new PresentonError(
      'invalid_input',
      `图片「${name}」不是有效的 base64 内容`
    );
  return Buffer.from(compact, 'base64');
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * 流程内上传图片或粘贴截图：文件落 wiki 现有存储（R2 或 public/uploads），
 * 元数据入 presentation_image，返回 image_id。校验沿用附件口径：
 * 单文件解码后 5MB、base64 总量 2MB；SVG 不接受（可带脚本）。
 */
export async function registerImage(
  owner: ImageOwner,
  file: { name: string; mime: string; base64: string },
  sourceType: 'upload' | 'paste',
  tags = ''
): Promise<PresentationImage> {
  const name = (file.name || '').trim();
  if (!name) throw new PresentonError('invalid_input', '图片缺少文件名');
  const ext = extOf(name);
  const mime = IMAGE_EXTS[ext];
  if (!mime)
    throw new PresentonError(
      'invalid_input',
      `图片「${name}」类型不支持，只接受 png、jpg、jpeg、gif、webp（不接受 SVG）`
    );
  if (
    file.mime &&
    file.mime.toLowerCase() !== 'application/octet-stream' &&
    file.mime.toLowerCase() !== mime
  )
    throw new PresentonError(
      'invalid_input',
      `图片「${name}」的文件类型与扩展名不符`
    );
  if ((file.base64 ?? '').length > MAX_TOTAL_BASE64_CHARS)
    throw new PresentonError(
      'invalid_input',
      `图片「${name}」超过 2MB，请压缩后再传`
    );
  const bytes = decodeBase64Strict(file.base64 ?? '', name);
  if (bytes.length === 0)
    throw new PresentonError('invalid_input', `图片「${name}」是空文件`);
  if (bytes.length > MAX_FILE_DECODED_BYTES)
    throw new PresentonError(
      'invalid_input',
      `图片「${name}」超过 5MB，请压缩后再传`
    );
  const dims = parseImageDimensions(bytes, ext);
  if (!dims)
    throw new PresentonError(
      'invalid_input',
      `图片「${name}」无法读取宽高，请换一份图片再试`
    );
  const key = `${md5(bytes)}.${ext}`;
  const storage = await getStorage();
  let storageKey = '';
  let storageUrl = '';
  if (!storage) {
    if ((globalThis as any).__CF_ENV__) {
      throw new PresentonError(
        'invalid_input',
        '文件存储未配置（R2），无法保存图片。请先在管理后台配置存储。',
        503
      );
    }
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(process.cwd(), 'public', 'uploads');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, key), bytes);
    storageKey = `uploads/${key}`;
    storageUrl = `/uploads/${key}`;
  } else {
    const exists = (await storage.exists?.({ key })) ?? false;
    if (!exists) {
      const result = await storage.uploadFile({
        body: bytes,
        key,
        contentType: mime,
        disposition: 'inline',
      });
      if (!result.success || !result.url)
        throw new PresentonError(
          'presenton_error',
          `图片「${name}」保存失败：${result.error || 'upload failed'}`,
          502
        );
      storageUrl = result.url;
    } else {
      storageUrl = storage.getPublicUrl?.({ key }) ?? '';
    }
    storageKey = key;
  }
  const [row] = await db()
    .insert(presentationImage)
    .values({
      id: getUuid(),
      ownerUserId: owner.userId,
      ownerTokenId: owner.tokenId ?? null,
      sourceType,
      sourceRef: name,
      fileName: name,
      tags: tags.slice(0, 500),
      width: dims.width,
      height: dims.height,
      fileSize: bytes.length,
      storageKey,
      storageUrl,
    })
    .returning();
  return row;
}

// ─── 检索 ───────────────────────────────────────────────────────────────────

export interface ImageSearchItem {
  imageId: string;
  sourceType: ImageSourceType;
  sourceRef: string;
  fileName: string;
  ownerId: string;
  width: number | null;
  height: number | null;
  fileSize: number | null;
  storageUrl: string;
  tags: string;
  lastUsedAt: string | null;
  createdAt: string;
}

function imgSrcsFromHtml(html: string): string[] {
  const out: string[] = [];
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const src = m[1].trim();
    if (src && !src.startsWith('data:') && !out.includes(src)) out.push(src);
  }
  return out;
}

function baseNameOf(url: string): string {
  const clean = url.split(/[?#]/)[0];
  const parts = clean.split('/').filter(Boolean);
  return parts[parts.length - 1] || url;
}

/**
 * 在调用人可见范围内检索图片：本人上传/粘贴的图 + 已发布文章配图 +
 * 可见 html 文档里的 <img>。只检索已有图，不生成新图。
 * sort=recent 按 last_used_at 排（最近使用优先），默认按上传时间倒序。
 */
export async function searchImages(
  viewer: ImageViewer,
  filters: {
    q?: string;
    tags?: string;
    sourceType?: ImageSourceType;
    sort?: 'recent' | 'newest';
    limit?: number;
  } = {}
): Promise<{ items: ImageSearchItem[] }> {
  const q = (filters.q || '').trim().toLowerCase();
  const tagFilter = (filters.tags || '').trim().toLowerCase();
  const limit = Math.min(Math.max(filters.limit ?? 20, 1), 50);
  const items: ImageSearchItem[] = [];

  const matchText = (hay: string) =>
    (!q || hay.toLowerCase().includes(q)) &&
    (!tagFilter || hay.toLowerCase().includes(tagFilter));

  // 本人上传/粘贴的图（元数据表）。
  if (
    !filters.sourceType ||
    filters.sourceType === 'upload' ||
    filters.sourceType === 'paste'
  ) {
    const rows = await db()
      .select()
      .from(presentationImage)
      .where(eq(presentationImage.ownerUserId, viewer.userId));
    for (const row of rows) {
      if (filters.sourceType && row.sourceType !== filters.sourceType) continue;
      if (!matchText(`${row.fileName} ${row.tags} ${row.sourceRef}`)) continue;
      items.push({
        imageId: row.id,
        sourceType: row.sourceType as ImageSourceType,
        sourceRef: row.sourceRef,
        fileName: row.fileName,
        ownerId: row.ownerUserId,
        width: row.width,
        height: row.height,
        fileSize: row.fileSize,
        storageUrl: row.storageUrl,
        tags: row.tags,
        lastUsedAt: row.lastUsedAt
          ? new Date(row.lastUsedAt).toISOString()
          : null,
        createdAt: new Date(row.createdAt).toISOString(),
      });
    }
  }

  // 已发布文章配图（post.image；草稿/归档文章的图不可见）。
  if (!filters.sourceType || filters.sourceType === 'wiki_blog') {
    const conditions = [eq(post.type, 'article'), eq(post.status, 'published')];
    if (q) {
      const safeQ = q.replace(/[%_]/g, '');
      conditions.push(
        or(like(post.title, `%${safeQ}%`), like(post.slug, `%${safeQ}%`))!
      );
    }
    const rows = await db()
      .select()
      .from(post)
      .where(and(...conditions));
    for (const row of rows) {
      const url = (row.image || '').trim();
      if (!url) continue;
      if (!matchText(`${row.title} ${row.slug} ${url}`)) continue;
      items.push({
        imageId: `blog:${row.id}`,
        sourceType: 'wiki_blog',
        sourceRef: row.slug,
        fileName: baseNameOf(url),
        ownerId: row.userId,
        width: null,
        height: null,
        fileSize: null,
        storageUrl: url,
        tags: row.tags || '',
        lastUsedAt: null,
        createdAt: new Date(row.createdAt).toISOString(),
      });
    }
  }

  // /wiki/html 文档里的 <img>（可见性沿用 canViewBlogHtml）。
  if (!filters.sourceType || filters.sourceType === 'wiki_html') {
    try {
      const docs = await listBlogHtml();
      for (const doc of docs) {
        if (
          !canViewBlogHtml(doc, {
            userId: viewer.userId,
            isAdmin: viewer.isAdmin,
          })
        )
          continue;
        if (!matchText(`${doc.title} ${doc.keywords} ${doc.key}`)) continue;
        const got = await getBlogHtml(doc.key);
        if (!got) continue;
        const srcs = imgSrcsFromHtml(got.content);
        srcs.forEach((src, i) => {
          if (!matchText(src)) return;
          items.push({
            imageId: `html:${doc.key}:${i}`,
            sourceType: 'wiki_html',
            sourceRef: doc.key,
            fileName: baseNameOf(src),
            ownerId: doc.uploaderId ?? '',
            width: null,
            height: null,
            fileSize: null,
            storageUrl: src,
            tags: doc.keywords || '',
            lastUsedAt: null,
            createdAt: doc.uploaded,
          });
        });
      }
    } catch {
      // html 索引失败不拖垮其余检索。
    }
  }

  // 库内图（blog/html）的宽高按需解析：只解析返回页内的条目。
  const sorted = [...items].sort((a, b) => {
    if (filters.sort === 'recent') {
      const at = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
      const bt = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
      if (bt !== at) return bt - at;
    }
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
  const page = sorted.slice(0, limit);
  for (const item of page) {
    if (item.width !== null) continue;
    try {
      const resolved = await resolveImageBytesById(viewer, item.imageId);
      if (resolved) {
        const dims = parseImageDimensions(resolved.bytes, extOf(resolved.name));
        if (dims) {
          item.width = dims.width;
          item.height = dims.height;
        }
        item.fileSize = resolved.bytes.length;
      }
    } catch {
      // 取不到字节时宽高留空，检索本身不失败。
    }
  }
  return { items: page };
}

// ─── 取图（生成时） ─────────────────────────────────────────────────────────

export type ResolvedImageRef =
  | { kind: 'stored'; row: PresentationImage }
  | { kind: 'blog'; postId: string; url: string; name: string }
  | { kind: 'html'; docKey: string; src: string; index: number };

/** 只校验存在与可见性，不取字节：不存在或无权时抛 404 语义的错。 */
export async function resolveImageRef(
  viewer: ImageViewer,
  imageId: string
): Promise<ResolvedImageRef> {
  if (imageId.startsWith('blog:')) {
    const postId = imageId.slice('blog:'.length);
    const [row] = await db()
      .select()
      .from(post)
      .where(eq(post.id, postId))
      .limit(1);
    if (!row || row.status !== 'published' || !(row.image || '').trim())
      throw new PresentonError('invalid_input', '图片不存在', 404);
    return {
      kind: 'blog',
      postId: row.id,
      url: row.image.trim(),
      name: baseNameOf(row.image.trim()),
    };
  }
  if (imageId.startsWith('html:')) {
    const rest = imageId.slice('html:'.length);
    const idx = rest.lastIndexOf(':');
    if (idx < 0) throw new PresentonError('invalid_input', '图片不存在', 404);
    const docKey = rest.slice(0, idx);
    const index = Number(rest.slice(idx + 1));
    const got = await getBlogHtml(docKey);
    if (
      !got ||
      !canViewBlogHtml(got.meta, {
        userId: viewer.userId,
        isAdmin: viewer.isAdmin,
      })
    )
      throw new PresentonError('invalid_input', '图片不存在', 404);
    const srcs = imgSrcsFromHtml(got.content);
    const src = srcs[index];
    if (!src) throw new PresentonError('invalid_input', '图片不存在', 404);
    return { kind: 'html', docKey, src, index };
  }
  const [row] = await db()
    .select()
    .from(presentationImage)
    .where(eq(presentationImage.id, imageId))
    .limit(1);
  if (
    !row ||
    row.ownerUserId !== viewer.userId ||
    (row.ownerTokenId ?? null) !== (viewer.tokenId ?? null)
  )
    throw new PresentonError('invalid_input', '图片不存在', 404);
  return { kind: 'stored', row };
}

/** 取图片字节：/uploads/ 读本地磁盘；R2 公开 URL 与本站同源 URL 走 fetch。 */
export async function resolveImageBytes(
  ref: ResolvedImageRef
): Promise<{ bytes: Buffer; mime: string; name: string } | null> {
  let url = '';
  let name = '';
  if (ref.kind === 'stored') {
    url = ref.row.storageUrl;
    name = ref.row.fileName;
  } else if (ref.kind === 'blog') {
    url = ref.url;
    name = ref.name;
  } else {
    url = ref.src;
    name = baseNameOf(ref.src);
  }
  const ext = extOf(name);
  const mime = IMAGE_EXTS[ext];
  if (!mime) return null;
  // /uploads/ 路径：直接读本地磁盘（容器内 public/uploads），不走公网。
  const uploadsIdx = url.indexOf('/uploads/');
  if (uploadsIdx >= 0) {
    const rel = url.slice(uploadsIdx + '/uploads/'.length).split(/[?#]/)[0];
    if (!rel || rel.includes('..') || rel.includes('/')) return null;
    try {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const bytes = await readFile(
        join(process.cwd(), 'public', 'uploads', rel)
      );
      return { bytes, mime, name };
    } catch {
      return null;
    }
  }
  // 绝对 URL：只允许本站同源与 R2 公开域（防 SSRF）；其余外域不取。
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const appOrigin = (() => {
    try {
      return new URL(envConfigs.app_url).origin;
    } catch {
      return '';
    }
  })();
  const configs = await getAllConfigs().catch(
    () => ({}) as Record<string, string>
  );
  const r2Domain = String(configs.r2_domain || '').trim();
  const allowed =
    (appOrigin && parsed.origin === appOrigin) ||
    (r2Domain &&
      (parsed.hostname === r2Domain ||
        parsed.hostname.endsWith(`.${r2Domain}`)));
  if (!allowed) return null;
  try {
    const res = await fetch(parsed.toString(), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_FILE_DECODED_BYTES)
      return null;
    return { bytes, mime, name };
  } catch {
    return null;
  }
}

export async function resolveImageBytesById(
  viewer: ImageViewer,
  imageId: string
): Promise<{ bytes: Buffer; mime: string; name: string } | null> {
  const ref = await resolveImageRef(viewer, imageId);
  return resolveImageBytes(ref);
}

// ─── 槽位映射 ───────────────────────────────────────────────────────────────

export interface ImageMappingInput {
  imageId: string;
  pageNo: number;
  slotId?: string;
}

/** 96dpi 下槽位英寸换算像素：图小于该值即 low_res（草稿中提示）。 */
const SLOT_DPI = 96;

export async function resolveImageMappings(
  viewer: ImageViewer,
  outlinePages: OutlinePage[],
  inputs: ImageMappingInput[]
): Promise<{
  assignments: ImageAssignment[];
  missingImagePages: number[];
}> {
  if (!inputs || inputs.length === 0)
    return {
      assignments: [],
      missingImagePages: missingImagePagesOf(outlinePages, []),
    };
  if (inputs.length > MAX_IMAGES_PER_TASK)
    throw new PresentonError(
      'invalid_input',
      `单次任务最多引用 ${MAX_IMAGES_PER_TASK} 张图片（已给 ${inputs.length} 张），请减少后重试`
    );
  const refs = new Map<string, ResolvedImageRef>();
  let pasteCount = 0;
  for (const input of inputs) {
    const ref = await resolveImageRef(viewer, input.imageId);
    refs.set(input.imageId, ref);
    if (ref.kind === 'stored' && ref.row.sourceType === 'paste') pasteCount++;
  }
  if (pasteCount > MAX_PASTE_IMAGES_PER_TASK)
    throw new PresentonError(
      'invalid_input',
      `单次任务最多引用 ${MAX_PASTE_IMAGES_PER_TASK} 张截图（已给 ${pasteCount} 张），请减少后重试`
    );
  const pageByNo = new Map(outlinePages.map((p) => [p.pageNo, p]));
  const assignments: ImageAssignment[] = [];
  for (const input of inputs) {
    const page = pageByNo.get(input.pageNo);
    if (!page)
      throw new PresentonError(
        'invalid_input',
        `第 ${input.pageNo} 页不在已确认的页面划分里`
      );
    const slots = allSlots(page.layout);
    const imageSlots = slots.filter(
      (s) => s.type === 'main_image' || s.type === 'small_image'
    );
    let slot = input.slotId
      ? slots.find((s) => s.id === input.slotId)
      : imageSlots[0];
    if (!slot)
      throw new PresentonError(
        'invalid_input',
        `第 ${input.pageNo} 页所用版式 ${page.layout} 没有图片槽位，无法放图`
      );
    if (slot.type !== 'main_image' && slot.type !== 'small_image')
      throw new PresentonError(
        'invalid_input',
        `槽位 ${input.slotId} 不是图片槽位（${slot.type}），请选择图片槽位`
      );
    const ref = refs.get(input.imageId)!;
    const dims =
      ref.kind === 'stored'
        ? { width: ref.row.width ?? 0, height: ref.row.height ?? 0 }
        : null;
    const needW = Math.ceil(slot.rectIn.width * SLOT_DPI);
    const needH = Math.ceil(slot.rectIn.height * SLOT_DPI);
    const lowRes = dims !== null && (dims.width < needW || dims.height < needH);
    assignments.push({
      pageNo: input.pageNo,
      slotId: slot.id,
      imageId: input.imageId,
      fileName:
        ref.kind === 'stored'
          ? ref.row.fileName
          : ref.kind === 'blog'
            ? ref.name
            : baseNameOf(ref.src),
      fitMode: 'cover',
      lowRes,
    });
  }
  return {
    assignments,
    missingImagePages: missingImagePagesOf(outlinePages, assignments),
  };
}

/** 有图片槽位、但未配图的页码（生成结果中列明“第 N 页缺图”）。 */
export function missingImagePagesOf(
  outlinePages: OutlinePage[],
  assignments: ImageAssignment[]
): number[] {
  const missing: number[] = [];
  const assigned = new Set(assignments.map((a) => a.pageNo));
  for (const page of outlinePages) {
    if (assigned.has(page.pageNo)) continue;
    const hasImageSlot = allSlots(page.layout).some(
      (s) => s.type === 'main_image' || s.type === 'small_image'
    );
    if (hasImageSlot) missing.push(page.pageNo);
  }
  return missing;
}

/** 生成时更新 last_used_at（供“最近使用”排序）。 */
export async function markImagesUsed(imageIds: string[]): Promise<void> {
  const ids = imageIds.filter(
    (id) => !id.startsWith('blog:') && !id.startsWith('html:')
  );
  if (ids.length === 0) return;
  const { inArray } = await import('drizzle-orm');
  await db()
    .update(presentationImage)
    .set({ lastUsedAt: new Date() })
    .where(inArray(presentationImage.id, ids));
}

// ─── Logo ───────────────────────────────────────────────────────────────────

/**
 * Logo 图片解析：Presenton 的生成接口不接受 Logo 参数，唯一能尝试的
 * 路径是把 Logo 当文件上传、再用 instructions 指定落位（见 service.ts
 * 的 logoInstruction，按 layouts.ts 的 PPT_LOGO_SLOT 落右上角）。
 *
 * 查找顺序（同一文件名先找开发路径、再找容器路径）：
 *   1. <cwd>/public/logo.{png,jpg,jpeg,webp} —— 本地开发（vite dev /
 *      直接跑 node），静态资源就在仓库的 public/ 下。
 *   2. <cwd>/.output/public/logo.{png,jpg,jpeg,webp} —— 生产容器：
 *      容器 cwd 是 /app，但最终镜像只从 builder 拷了 .output，/app/public
 *      根本不存在；静态资源实际在 /app/.output/public/。只读 public/
 *      会使容器里永远返回 null（2026-11-25 实测定位）。
 *
 * 仓库里已放真实 Sysmex Logo：public/logo.png（275×110，2026-11-25
 * 用户给的 https://eu.sysmex.com.cn/logo.png）。public/logo.svg 仍是
 * ShipAny 默认占位（黑方块＋S），SVG 不被上传通道接受、永不使用。
 * 两个位置都没有光栅 Logo 时返回 null，由调用方如实记录
 * “未配置 Logo 图片”，不编造、不拿占位图顶替。
 */
export async function tryResolveLogo(): Promise<{
  bytes: Buffer;
  mime: string;
  name: string;
} | null> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  for (const file of ['logo.png', 'logo.jpg', 'logo.jpeg', 'logo.webp']) {
    for (const dir of ['public', join('.output', 'public')]) {
      try {
        const bytes = await readFile(join(process.cwd(), dir, file));
        const ext = extOf(file);
        const mime = IMAGE_EXTS[ext];
        if (!mime) continue;
        return { bytes, mime, name: file };
      } catch {
        continue;
      }
    }
  }
  return null;
}
