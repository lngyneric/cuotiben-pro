// 单页编辑版本文件 —— 阶段 2 能力三。
//
// 每个已确认的编辑版本是一份完整 PPTX，存在与库文件同目录的 ppt-edits/
// 下（生产 DATABASE_URL=file:/app/data/blog.db → /app/data/ppt-edits，
// 随命名卷持久化、容器重建不丢；public/uploads 不进卷，不能放）。
// 元数据在 presentation_page_version 表里（jobId + version + pageNo +
// ops + fileName）。version 0 是 Presenton 原稿，不建行。
//
// 目录解析：DATABASE_URL 是 file: URL 时取其所在目录；否则（D1 /
// Postgres 等无本地库文件的部署）回落到 ./data/ppt-edits——该形态下
// 版本文件不保证持久化，调用方须在部署时配成本地 SQLite（本 wiki 的
// 内网部署即此形态）。

import { desc, eq } from 'drizzle-orm';

import { db } from '@/core/db';
import { envConfigs } from '@/config';
import {
  presentationPageVersion,
  type PresentationPageVersion,
} from '@/config/db/schema';
import { getUuid } from '@/lib/hash';

import { PresentonError } from './errors';

export function getPageEditsDir(): string {
  const url = (envConfigs.database_url || '').trim();
  if (url.startsWith('file:')) {
    try {
      const path = new URL(url).pathname;
      const dir = path.slice(0, path.lastIndexOf('/'));
      if (dir) return `${dir}/ppt-edits`;
    } catch {
      // fall through
    }
  }
  return './data/ppt-edits';
}

export function versionFileName(jobId: string, version: number): string {
  const safeJob = jobId.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${safeJob}-v${version}.pptx`;
}

async function writeVersionFile(
  jobId: string,
  version: number,
  bytes: Buffer
): Promise<string> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = getPageEditsDir();
  await mkdir(dir, { recursive: true });
  const fileName = versionFileName(jobId, version);
  await writeFile(join(dir, fileName), bytes);
  return fileName;
}

async function readVersionFile(fileName: string): Promise<Buffer | null> {
  // fileName 只允许本模块生成的安全形态，拒绝路径穿越。
  if (!/^[A-Za-z0-9_-]+-v\d+\.pptx$/.test(fileName)) return null;
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    return await readFile(join(getPageEditsDir(), fileName));
  } catch {
    return null;
  }
}

export async function listPageVersions(
  jobId: string
): Promise<PresentationPageVersion[]> {
  return db()
    .select()
    .from(presentationPageVersion)
    .where(eq(presentationPageVersion.jobId, jobId))
    .orderBy(desc(presentationPageVersion.version));
}

/** 当前版本号：无编辑行时为 0（Presenton 原稿）。 */
export async function getCurrentPageVersion(jobId: string): Promise<number> {
  const rows = await listPageVersions(jobId);
  return rows[0]?.version ?? 0;
}

export async function getPageVersion(
  jobId: string,
  version: number
): Promise<PresentationPageVersion | undefined> {
  const rows = await db()
    .select()
    .from(presentationPageVersion)
    .where(eq(presentationPageVersion.jobId, jobId));
  return rows.find((r: PresentationPageVersion) => r.version === version);
}

export async function readPageVersionBytes(
  row: PresentationPageVersion
): Promise<Buffer | null> {
  return readVersionFile(row.fileName);
}

/**
 * 写一个新版本：先落盘、再记行。落盘失败不记行；记行失败则尽力删掉
 * 刚落盘的文件，不留孤儿版本。
 */
export async function createPageVersion(params: {
  jobId: string;
  version: number;
  pageNo: number;
  ops: unknown;
  bytes: Buffer;
}): Promise<PresentationPageVersion> {
  const fileName = await writeVersionFile(
    params.jobId,
    params.version,
    params.bytes
  );
  try {
    const [row] = await db()
      .insert(presentationPageVersion)
      .values({
        id: getUuid(),
        jobId: params.jobId,
        version: params.version,
        pageNo: params.pageNo,
        ops: JSON.stringify(params.ops),
        fileName,
      })
      .returning();
    return row;
  } catch (error) {
    const { rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await rm(join(getPageEditsDir(), fileName), { force: true }).catch(
      () => {}
    );
    throw error;
  }
}

/** 版本行里的 ops 原样解析；坏结构按空数组处理，不拖垮查询。 */
export function parseVersionOps(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function assertJobReadyForPageEdit(job: {
  status: string;
  exportPath: string | null;
}): void {
  if (job.status !== 'completed' || !job.exportPath)
    throw new PresentonError(
      'invalid_input',
      'Presentation is not ready for page editing'
    );
}
