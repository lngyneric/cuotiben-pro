// Blog HTML storage — two backends, chosen at runtime, same interface.
//
// - R2 (`globalThis.__CF_ENV__.HTML_BUCKET` present, i.e. Cloudflare Workers):
//   the existing behaviour, byte for byte. Uploaded objects keep only
//   title/description/category in R2 customMetadata; visibility/uploader are
//   not tracked there (the public site predates them).
// - Local (everywhere else, i.e. the intranet Node server): HTML files on
//   server disk (BLOG_HTML_DIR) + metadata in the SQLite `blog_html_file`
//   table. No object storage, no Cloudflare dependency.
//
// Routes (`src/routes/api/blog/html*.ts`) talk to this module only, never to
// R2 or the disk directly, so the API contract (key/title/description/
// category/size/uploaded/url) is identical on both backends.
//
// NOTE on imports: the local backend needs `node:fs`/`node:path`, which do
// not exist on Cloudflare Workers. They are therefore loaded with dynamic
// `import()` inside the local branch only — never at module top level — so
// the Workers bundle keeps building. Likewise `blogHtmlFile` is read via a
// dynamic import of `@/config/db/schema`: the postgres/mysql schema
// templates intentionally do NOT define that table (intranet SQLite only),
// and a static import would break their builds.

import { desc, eq } from 'drizzle-orm';

import { db } from '@/core/db';
import { envConfigs } from '@/config';
import { getAppBasePath } from '@/lib/base-path';

export type BlogHtmlVisibility = 'all' | 'self';

export interface BlogHtmlMeta {
  key: string;
  title: string;
  description: string;
  category: string;
  visibility: BlogHtmlVisibility;
  uploaderId: string | null;
  uploaderEmployeeNo: string;
  sha256: string;
  size: number;
  uploaded: string;
}

export interface BlogHtmlItem extends BlogHtmlMeta {
  url: string;
}

export type BlogStorageBackend = 'r2' | 'local';

export function getBlogStorageBackend(): BlogStorageBackend {
  const bucket = (globalThis as any).__CF_ENV__?.HTML_BUCKET;
  return bucket ? 'r2' : 'local';
}

function getBucket(): any {
  const env = (globalThis as any).__CF_ENV__;
  return env?.HTML_BUCKET || null;
}

// Keys are always `html/<file>.html` with a single flat segment. Anything
// else (subdirectories, `..`, absolute paths, other extensions) is rejected
// before it can reach the filesystem or R2.
const KEY_RE = /^html\/[A-Za-z0-9][A-Za-z0-9._-]*\.html$/;

export function assertSafeBlogKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error('Invalid key');
}

export function blogHtmlUrl(key: string): string {
  // Server-side: the base path comes from the baked Vite base or the
  // runtime APP_BASE_PATH env (see src/lib/base-path.ts).
  const base = getAppBasePath();
  const path = `/api/blog/html/${encodeURIComponent(key)}`;
  return base ? `${base}${path}` : path;
}

function toItem(meta: BlogHtmlMeta): BlogHtmlItem {
  return { ...meta, url: blogHtmlUrl(meta.key) };
}

// ─── R2 backend (existing behaviour, unchanged) ─────────────────────────────

async function r2List(): Promise<BlogHtmlItem[]> {
  const bucket = getBucket();
  if (!bucket) throw new Error('R2 bucket not configured');
  const listed = await bucket.list({ prefix: 'html/' });
  const items = await Promise.all(
    (listed.objects || []).map(async (o: any) => {
      let title = o.key.replace('html/', '').replace('.html', '');
      let description = '';
      let category = '未分类';
      // Objects uploaded before visibility/uploader tracking carry none of
      // these keys; they default to "all visible, no owner" (legacy).
      let visibility: BlogHtmlVisibility = 'all';
      let uploaderId: string | null = null;
      let uploaderEmployeeNo = '';
      try {
        const head = await bucket.head(o.key);
        if (head?.customMetadata?.title) title = head.customMetadata.title;
        if (head?.customMetadata?.description)
          description = head.customMetadata.description;
        if (head?.customMetadata?.category)
          category = head.customMetadata.category;
        if (head?.customMetadata?.visibility === 'self') visibility = 'self';
        if (head?.customMetadata?.uploader_id)
          uploaderId = head.customMetadata.uploader_id;
        if (head?.customMetadata?.uploader_employee_no)
          uploaderEmployeeNo = head.customMetadata.uploader_employee_no;
      } catch {
        // ignore, fallback to filename
      }
      return toItem({
        key: o.key,
        title,
        description,
        category,
        visibility,
        uploaderId,
        uploaderEmployeeNo,
        sha256: '',
        size: o.size ?? 0,
        uploaded: o.uploaded ? new Date(o.uploaded).toISOString() : '',
      });
    })
  );
  items.sort(
    (a, b) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime()
  );
  return items;
}

async function r2Get(
  key: string
): Promise<{ content: string; meta: BlogHtmlMeta } | null> {
  const bucket = getBucket();
  if (!bucket) throw new Error('R2 bucket not configured');
  const obj = await bucket.get(key);
  if (!obj) return null;
  const content = await obj.text();
  const meta = obj.customMetadata || {};
  return {
    content,
    meta: {
      key,
      title: meta.title || '',
      description: meta.description || '',
      category: meta.category || '未分类',
      visibility: meta.visibility === 'self' ? 'self' : 'all',
      uploaderId: meta.uploader_id || null,
      uploaderEmployeeNo: meta.uploader_employee_no || '',
      sha256: '',
      size: content.length,
      uploaded: obj.uploaded ? new Date(obj.uploaded).toISOString() : '',
    },
  };
}

async function r2Put(
  key: string,
  content: string,
  meta: {
    title: string;
    description: string;
    category: string;
    visibility?: BlogHtmlVisibility;
    uploaderId?: string | null;
    uploaderEmployeeNo?: string;
  }
): Promise<void> {
  const bucket = getBucket();
  if (!bucket) throw new Error('R2 bucket not configured');
  await bucket.put(key, content, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
    customMetadata: {
      title: meta.title,
      description: meta.description,
      category: meta.category,
      // New uploads carry ownership so the same visibility/owner rules can
      // apply on R2 too; old objects simply lack these keys (see r2List).
      visibility: meta.visibility ?? 'all',
      uploader_id: meta.uploaderId ?? '',
      uploader_employee_no: meta.uploaderEmployeeNo ?? '',
    },
  });
}

async function r2Delete(key: string): Promise<void> {
  const bucket = getBucket();
  if (!bucket) throw new Error('R2 bucket not configured');
  await bucket.delete(key);
}

// ─── Local backend (intranet: disk + SQLite) ────────────────────────────────

function requireSqlite(): void {
  if (envConfigs.database_provider !== 'sqlite') {
    throw new Error(
      'Local blog storage requires DATABASE_PROVIDER=sqlite ' +
        `(got ${envConfigs.database_provider}); the blog_html_file table ` +
        'is only defined in the SQLite schema template.'
    );
  }
}

async function localTable(): Promise<any> {
  // Dynamic import: the postgres/mysql schema templates do not export
  // blogHtmlFile, and a static import would break their builds.
  const schema = (await import('@/config/db/schema')) as any;
  const table = schema.blogHtmlFile;
  if (!table) {
    throw new Error(
      'blog_html_file table is not defined in the active schema template ' +
        '(intranet SQLite only).'
    );
  }
  return table;
}

function localDir(): string {
  // Resolve against process.cwd() (/app in the container, repo root locally).
  // Kept in a function (not module scope) so tests can change the env first.
  return envConfigs.blog_html_dir || './data/blog-html';
}

async function localFilePath(key: string): Promise<string> {
  assertSafeBlogKey(key);
  const { resolve, sep } = await import('node:path');
  const dir = resolve(localDir());
  const file = resolve(dir, key.slice('html/'.length));
  // Defence in depth (KEY_RE already forbids `/` and `..`): never escape dir.
  if (file !== dir && !file.startsWith(dir + sep)) {
    throw new Error('Invalid key');
  }
  return file;
}

function rowToMeta(row: any): BlogHtmlMeta {
  return {
    key: row.key,
    title: row.title ?? '',
    description: row.description ?? '',
    category: row.category ?? '未分类',
    visibility: row.visibility === 'self' ? 'self' : 'all',
    uploaderId: row.uploaderId ?? null,
    uploaderEmployeeNo: row.uploaderEmployeeNo ?? '',
    sha256: row.sha256 ?? '',
    size: row.size ?? 0,
    uploaded:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : new Date(row.createdAt).toISOString(),
  };
}

async function localList(): Promise<BlogHtmlItem[]> {
  requireSqlite();
  const table = await localTable();
  const rows = await db().select().from(table).orderBy(desc(table.createdAt));
  return rows.map((row: any) => toItem(rowToMeta(row)));
}

async function localGet(
  key: string
): Promise<{ content: string; meta: BlogHtmlMeta } | null> {
  requireSqlite();
  const table = await localTable();
  const rows = await db().select().from(table).where(eq(table.key, key));
  const row = rows[0];
  if (!row) return null;
  const file = await localFilePath(key);
  const { readFile } = await import('node:fs/promises');
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  return { content, meta: rowToMeta(row) };
}

async function localPut(
  key: string,
  content: string,
  meta: {
    title: string;
    description: string;
    category: string;
    visibility: BlogHtmlVisibility;
    uploaderId: string | null;
    uploaderEmployeeNo: string;
  }
): Promise<void> {
  requireSqlite();
  const table = await localTable();
  const { createHash } = await import('node:crypto');
  const { mkdir, rm, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const size = Buffer.byteLength(content, 'utf8');
  const file = await localFilePath(key);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  try {
    await db()
      .insert(table)
      .values({
        key,
        title: meta.title,
        description: meta.description,
        category: meta.category,
        visibility: meta.visibility,
        uploaderId: meta.uploaderId,
        uploaderEmployeeNo: meta.uploaderEmployeeNo,
        sha256,
        size,
      })
      .onConflictDoUpdate({
        target: table.key,
        set: {
          title: meta.title,
          description: meta.description,
          category: meta.category,
          visibility: meta.visibility,
          uploaderId: meta.uploaderId,
          uploaderEmployeeNo: meta.uploaderEmployeeNo,
          sha256,
          size,
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    // Don't leave an orphan file behind when the metadata write fails.
    await rm(file, { force: true });
    throw error;
  }
}

async function localDelete(key: string): Promise<void> {
  requireSqlite();
  const table = await localTable();
  await db().delete(table).where(eq(table.key, key));
  const file = await localFilePath(key);
  const { rm } = await import('node:fs/promises');
  await rm(file, { force: true });
}

async function localUpdateCategory(
  key: string,
  category: string
): Promise<void> {
  requireSqlite();
  const table = await localTable();
  const rows = await db()
    .update(table)
    .set({ category, updatedAt: new Date() })
    .where(eq(table.key, key))
    .returning({ key: table.key });
  if (!rows || rows.length === 0) throw new Error('Not found');
}

// ─── Unified facade (routes use only this) ──────────────────────────────────

export async function listBlogHtml(): Promise<BlogHtmlItem[]> {
  return getBlogStorageBackend() === 'r2' ? r2List() : localList();
}

export async function getBlogHtml(
  key: string
): Promise<{ content: string; meta: BlogHtmlMeta } | null> {
  assertSafeBlogKey(key);
  return getBlogStorageBackend() === 'r2' ? r2Get(key) : localGet(key);
}

export async function putBlogHtml(
  key: string,
  content: string,
  meta: {
    title: string;
    description: string;
    category: string;
    visibility: BlogHtmlVisibility;
    uploaderId: string | null;
    uploaderEmployeeNo: string;
  }
): Promise<BlogHtmlItem> {
  assertSafeBlogKey(key);
  if (getBlogStorageBackend() === 'r2') {
    await r2Put(key, content, meta);
    const got = await r2Get(key);
    if (!got) throw new Error('Upload failed');
    return toItem(got.meta);
  }
  await localPut(key, content, meta);
  const got = await localGet(key);
  if (!got) throw new Error('Upload failed');
  return toItem(got.meta);
}

export async function deleteBlogHtml(key: string): Promise<void> {
  assertSafeBlogKey(key);
  if (getBlogStorageBackend() === 'r2') await r2Delete(key);
  else await localDelete(key);
}

export async function updateBlogHtmlCategory(
  key: string,
  category: string
): Promise<void> {
  assertSafeBlogKey(key);
  if (getBlogStorageBackend() === 'r2') {
    const got = await r2Get(key);
    if (!got) throw new Error('Not found');
    await r2Put(key, got.content, {
      title: got.meta.title,
      description: got.meta.description,
      category,
      visibility: got.meta.visibility,
      uploaderId: got.meta.uploaderId,
      uploaderEmployeeNo: got.meta.uploaderEmployeeNo,
    });
    return;
  }
  await localUpdateCategory(key, category);
}
