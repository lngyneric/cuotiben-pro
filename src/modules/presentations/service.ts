// Presentations (PPT) — wiki agent 侧的 PPT 生成任务，引擎是内网 Presenton。
//
// 设计要点（见 admin 操作 presentations_generate / presentations_get）：
// - wiki 不跑后台 worker：standard 模式走 Presenton 的 /generate/async，
//   任务状态由 presentations_get 每次查询时轮询一次 Presenton 后更新；
//   smart 模式的生成由 Presenton 的 SSE stream 驱动，wiki 用一个 detached
//   promise 消费完 stream（进程重启导致中断时，下一次查询会重新接上）。
// - 归属隔离：Presenton 侧是共用管理员账号，所有 deck 在其名下互见，所以
//   job 行登记调用方身份（ownerUserId + ownerTokenId），查询与下载只放行
//   属主；Presenton 的原生编辑地址（edit_path）绝不返回给调用方。
// - 额度/限流是独立错误：Magpie 侧 429 或 quota/rate-limit 文本一律归类为
//   llm_quota_exceeded（不报成笼统 500），并走 notify 模块提醒管理员。
// - 跨模块 import 的例外：config（读 presenton 配置，payment/notify 同款
//   用法）与 notify（额度提醒，payment→notify 的同款例外）。post 内容直接
//   查 post 表，不 import posts 模块（ai-assistant/mcp.ts 的同款做法）。

import { eq, sql } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  post,
  presentationJob,
  type PresentationJob,
} from '@/config/db/schema';
import { getConfig } from '@/modules/config/service';
import { notifyLlmQuotaExceeded } from '@/modules/notify/service';
import { getUuid } from '@/lib/hash';

export type PresentationMode = 'standard' | 'smart';
export type PresentationJobStatus =
  | 'queued'
  | 'generating'
  | 'completed'
  | 'failed';

export const PRESENTON_DEFAULT_BASE_URL = 'http://presenton-trial:80';
export const MAX_SLIDES = 50;
export const MAX_FILES = 10;
/** MCP/Execute 请求上限 2MB，base64 解码后总量不超 1.5MB。 */
export const MAX_TOTAL_FILE_BYTES = 1_500_000;
/** 拼进生成提示的素材上限（wiki 文章可能很长）。 */
export const MAX_ASSEMBLED_CONTENT_CHARS = 100_000;

const CONTROL_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const STREAM_TIMEOUT_MS = 10 * 60_000;

const QUOTA_PATTERN = /rate.?limit|quota|insufficient|too many requests/i;

/** 文件扩展名 → 允许的 MIME（Presenton 侧还会再校验一次；不含 SVG）。 */
const ALLOWED_FILE_TYPES: Record<string, string[]> = {
  pdf: ['application/pdf'],
  doc: ['application/msword'],
  docx: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  odt: ['application/vnd.oasis.opendocument.text'],
  rtf: ['application/rtf', 'text/rtf'],
  ppt: ['application/vnd.ms-powerpoint'],
  pptx: [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  csv: ['text/csv'],
  txt: ['text/plain'],
  md: ['text/markdown', 'text/x-markdown'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  webp: ['image/webp'],
};

export type PresentonErrorCode =
  | 'not_configured'
  | 'invalid_input'
  | 'llm_quota_exceeded'
  | 'presenton_error';

export class PresentonError extends Error {
  constructor(
    public code: PresentonErrorCode,
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export interface PresentationFileInput {
  name: string;
  mime: string;
  base64: string;
}

export interface GenerateInput {
  content?: string;
  nSlides?: number;
  language?: string;
  template?: string;
  mode: PresentationMode;
  instructions?: string;
  files?: PresentationFileInput[];
  postSlugs?: string[];
}

function isQuotaSignal(status: number | undefined, text: string): boolean {
  return status === 429 || QUOTA_PATTERN.test(text || '');
}

function classifyError(
  status: number | undefined,
  text: string
): {
  code: PresentonErrorCode;
  message: string;
} {
  const snippet = (text || '').slice(0, 500);
  if (isQuotaSignal(status, snippet))
    return {
      code: 'llm_quota_exceeded',
      message: `llm_quota_exceeded: Magpie 额度或限流（${snippet || `HTTP ${status}`})`,
    };
  return {
    code: 'presenton_error',
    message: snippet
      ? `Presenton error (HTTP ${status ?? '?'}): ${snippet}`
      : `Presenton error (HTTP ${status ?? '?'})`,
  };
}

function decodeBase64Strict(base64: string, name: string): Buffer {
  const compact = base64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0)
    throw new PresentonError(
      'invalid_input',
      `Invalid base64 content for file '${name}'`
    );
  return Buffer.from(compact, 'base64');
}

function validateFiles(files: PresentationFileInput[]): Buffer[] {
  if (files.length > MAX_FILES)
    throw new PresentonError(
      'invalid_input',
      `At most ${MAX_FILES} files per request`
    );
  let total = 0;
  return files.map((file) => {
    const name = (file.name || '').split(/[\\/]/).pop() || 'file';
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const allowed = ALLOWED_FILE_TYPES[ext];
    if (!allowed)
      throw new PresentonError(
        'invalid_input',
        `File type not allowed: '${name}'`
      );
    if (file.mime && !allowed.includes(file.mime.toLowerCase()))
      throw new PresentonError(
        'invalid_input',
        `MIME type not allowed for '${name}': ${file.mime}`
      );
    const bytes = decodeBase64Strict(file.base64, name);
    total += bytes.byteLength;
    if (total > MAX_TOTAL_FILE_BYTES)
      throw new PresentonError(
        'invalid_input',
        `Total file size exceeds ${MAX_TOTAL_FILE_BYTES} bytes after decoding`
      );
    return bytes;
  });
}

async function getPresentonConfig(): Promise<{
  baseUrl: string;
  apiKey: string;
}> {
  const baseUrl =
    ((await getConfig('presenton_base_url')) || '')
      .trim()
      .replace(/\/+$/, '') || PRESENTON_DEFAULT_BASE_URL;
  const apiKey = ((await getConfig('presenton_api_key')) || '').trim();
  if (!apiKey)
    throw new PresentonError(
      'not_configured',
      'Presenton is not configured: fill presenton_api_key in Admin → Settings → AI → PPT（Presenton）',
      503
    );
  return { baseUrl, apiKey };
}

interface PresentonResponse {
  status: number;
  text: string;
  json: unknown;
}

async function presentonFetch(
  path: string,
  init: RequestInit,
  timeoutMs: number
): Promise<PresentonResponse> {
  const { baseUrl, apiKey } = await getPresentonConfig();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        ...(init.headers || {}),
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } catch (error) {
    throw new PresentonError(
      'presenton_error',
      `Cannot reach Presenton (${baseUrl}): ${error instanceof Error ? error.message : 'network error'}`,
      502
    );
  }
  const text = await response.text().catch(() => '');
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const { code, message } = classifyError(response.status, text);
    throw new PresentonError(
      code,
      message,
      code === 'llm_quota_exceeded' ? 429 : 502
    );
  }
  return { status: response.status, text, json };
}

async function presentonJson<T>(
  path: string,
  body: unknown,
  timeoutMs = CONTROL_TIMEOUT_MS
): Promise<T> {
  const { json } = await presentonFetch(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    timeoutMs
  );
  return json as T;
}

/** 把 Presenton 返回的导出路径解析成可直接请求的 URL（只在服务端用）。 */
function resolveExportUrl(baseUrl: string, exportPath: string): string {
  if (exportPath.startsWith('/')) return `${baseUrl}${exportPath}`;
  let url: URL;
  try {
    url = new URL(exportPath);
  } catch {
    throw new PresentonError(
      'presenton_error',
      'Presenton returned an invalid export path'
    );
  }
  if (url.origin !== new URL(baseUrl).origin)
    throw new PresentonError(
      'presenton_error',
      'Presenton returned an export URL outside the configured server'
    );
  return exportPath;
}

// ─── Presenton API ─────────────────────────────────────────────────────────

/** base64 文件 → Presenton 服务端临时路径（/mcp-upload，JSON，不走 multipart）。 */
async function uploadFiles(files: PresentationFileInput[]): Promise<string[]> {
  const { file_paths } = await presentonJson<{ file_paths: string[] }>(
    '/api/v1/ppt/files/mcp-upload',
    {
      files: files.map((file) => ({
        filename: (file.name || '').split(/[\\/]/).pop() || 'file',
        content_base64: file.base64.replace(/\s+/g, ''),
      })),
    },
    UPLOAD_TIMEOUT_MS
  );
  if (!Array.isArray(file_paths) || file_paths.length === 0)
    throw new PresentonError(
      'presenton_error',
      'Presenton upload returned no file paths'
    );
  return file_paths;
}

interface AsyncTask {
  id: string;
  status: 'pending' | 'completed' | 'error';
  message?: string | null;
  error?: unknown;
  data?: {
    presentation_id?: string;
    path?: string;
    edit_path?: string;
    created_slides?: number;
    remaining_slides?: number;
  } | null;
}

async function startStandardGeneration(params: {
  content: string;
  nSlides?: number;
  language: string;
  template: string;
  instructions?: string;
  filePaths: string[];
}): Promise<{ taskId: string; presentationId: string }> {
  const task = await presentonJson<AsyncTask>(
    '/api/v1/ppt/presentation/generate/async',
    {
      content: params.content,
      n_slides: params.nSlides,
      language: params.language,
      template: params.template,
      tone: 'professional',
      verbosity: 'standard',
      files: params.filePaths,
      instructions: params.instructions,
      export_as: 'pptx',
    },
    CONTROL_TIMEOUT_MS
  );
  const presentationId = task?.data?.presentation_id;
  if (!task?.id || !presentationId)
    throw new PresentonError(
      'presenton_error',
      'Presenton async generation returned no task id'
    );
  return { taskId: task.id, presentationId };
}

async function getTaskStatus(taskId: string): Promise<AsyncTask> {
  const { json } = await presentonFetch(
    `/api/v1/ppt/presentation/status/${encodeURIComponent(taskId)}`,
    { method: 'GET' },
    CONTROL_TIMEOUT_MS
  );
  return json as AsyncTask;
}

interface PresentationInfo {
  id: string;
  title?: string | null;
  slides?: unknown[];
}

async function getPresentation(
  presentationId: string
): Promise<PresentationInfo> {
  const { json } = await presentonFetch(
    `/api/v1/ppt/presentation/${encodeURIComponent(presentationId)}`,
    { method: 'GET' },
    CONTROL_TIMEOUT_MS
  );
  return json as PresentationInfo;
}

async function exportPresentation(
  presentationId: string
): Promise<{ path: string; edit_path?: string }> {
  return presentonJson<{ path: string; edit_path?: string }>(
    `/api/v1/ppt/presentation/${encodeURIComponent(presentationId)}/export`,
    { export_as: 'pptx' },
    CONTROL_TIMEOUT_MS
  );
}

/**
 * Smart 模式的生成由这个 SSE stream 驱动：消费完 stream 才算生成结束。
 * 生成失败时 Presenton 经常只给一个空 slides 列表，所以调用方必须在 stream
 * 结束后查 slides 数量再定论。
 */
async function consumeSmartStream(presentationId: string): Promise<void> {
  const { baseUrl, apiKey } = await getPresentonConfig();
  let response: Response;
  try {
    response = await fetch(
      `${baseUrl}/api/v1/ppt/presentation/stream/${encodeURIComponent(presentationId)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
      }
    );
  } catch (error) {
    throw new PresentonError(
      'presenton_error',
      `Cannot reach Presenton (${baseUrl}): ${error instanceof Error ? error.message : 'network error'}`,
      502
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const { code, message } = classifyError(response.status, text);
    throw new PresentonError(
      code,
      message,
      code === 'llm_quota_exceeded' ? 429 : 502
    );
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

async function downloadPptxBytes(exportPath: string): Promise<Buffer> {
  const { baseUrl, apiKey } = await getPresentonConfig();
  const url = resolveExportUrl(baseUrl, exportPath);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new PresentonError(
      'presenton_error',
      `Cannot download pptx from Presenton: ${error instanceof Error ? error.message : 'network error'}`,
      502
    );
  }
  if (!response.ok)
    throw new PresentonError(
      'presenton_error',
      `Presenton download failed (HTTP ${response.status})`,
      502
    );
  const bytes = Buffer.from(await response.arrayBuffer());
  // pptx 是 zip 包；第一字节不是 PK 说明拿到的不是文件。
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
    throw new PresentonError(
      'presenton_error',
      'Presenton returned a download that is not a pptx file'
    );
  return bytes;
}

// ─── Jobs ──────────────────────────────────────────────────────────────────

export async function getJob(id: string): Promise<PresentationJob | undefined> {
  const [row] = await db()
    .select()
    .from(presentationJob)
    .where(eq(presentationJob.id, id))
    .limit(1);
  return row;
}

/** 归属校验：userId 与 tokenId 必须同时对上（session 调用方 tokenId 为空）。 */
export function isJobOwner(
  job: PresentationJob,
  actor: { userId: string; tokenId?: string }
): boolean {
  return (
    job.ownerUserId === actor.userId &&
    (job.ownerTokenId ?? null) === (actor.tokenId ?? null)
  );
}

/** 找不到或非属主都返回 null——调用方只看到 404，分不清是哪一种。 */
export async function findOwnedJob(
  id: string,
  actor: { userId: string; tokenId?: string }
): Promise<PresentationJob | null> {
  const job = await getJob(id);
  if (!job || !isJobOwner(job, actor)) return null;
  return job;
}

async function updateJob(
  id: string,
  patch: Partial<typeof presentationJob.$inferInsert>
): Promise<PresentationJob | undefined> {
  const [row] = await db()
    .update(presentationJob)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(presentationJob.id, id))
    .returning();
  return row;
}

async function failJob(
  job: PresentationJob,
  error: unknown
): Promise<PresentationJob | undefined> {
  let code: PresentonErrorCode = 'presenton_error';
  let message = 'Presentation generation failed';
  if (error instanceof PresentonError) {
    code = error.code;
    message = error.message;
  } else if (error instanceof Error) {
    message = error.message.slice(0, 500);
    if (isQuotaSignal(undefined, message)) code = 'llm_quota_exceeded';
  }
  const updated = await updateJob(job.id, {
    status: 'failed',
    error: message,
    errorCode: code,
  });
  if (code === 'llm_quota_exceeded') {
    // 额度提醒是 best-effort：提醒失败也不能影响任务本身的状态写入。
    await notifyLlmQuotaExceeded({
      jobId: job.id,
      title: job.title || '',
      detail: message,
    }).catch(() => {});
  }
  return updated;
}

async function completeJob(
  job: PresentationJob,
  params: { title?: string | null; slideCount: number; exportPath: string }
): Promise<PresentationJob | undefined> {
  return updateJob(job.id, {
    status: 'completed',
    title: params.title || job.title,
    slideCount: params.slideCount,
    exportPath: params.exportPath,
  });
}

function deriveTitle(input: GenerateInput, postTitles: string[]): string {
  const fromContent = (input.content || '').trim().split(/\n/)[0]?.slice(0, 60);
  return fromContent || postTitles[0]?.slice(0, 60) || 'PPT';
}

/** 把 wiki 文章拼进生成素材（只取标题+正文，大小写不敏感查 slug）。 */
async function assembleContent(input: GenerateInput): Promise<{
  content: string;
  postTitles: string[];
}> {
  const parts: string[] = [];
  if (input.content?.trim()) parts.push(input.content.trim());
  const postTitles: string[] = [];
  for (const slug of input.postSlugs || []) {
    const [row] = await db()
      .select()
      .from(post)
      .where(eq(sql`lower(${post.slug})`, slug.toLowerCase()))
      .limit(1);
    if (!row)
      throw new PresentonError('invalid_input', `Post not found: ${slug}`);
    postTitles.push(row.title);
    parts.push(`## ${row.title}\n\n${row.content || ''}`);
  }
  const content = parts.join('\n\n').slice(0, MAX_ASSEMBLED_CONTENT_CHARS);
  if (!content)
    throw new PresentonError(
      'invalid_input',
      'Provide content, files, or postSlugs'
    );
  return { content, postTitles };
}

export function validateGenerateInput(input: GenerateInput): void {
  if (
    !input.content?.trim() &&
    (!input.files || input.files.length === 0) &&
    (!input.postSlugs || input.postSlugs.length === 0)
  )
    throw new PresentonError(
      'invalid_input',
      'Provide content, files, or postSlugs'
    );
  if (
    input.nSlides !== undefined &&
    (input.nSlides < 1 || input.nSlides > MAX_SLIDES)
  )
    throw new PresentonError(
      'invalid_input',
      `nSlides must be between 1 and ${MAX_SLIDES}`
    );
  if (input.files) validateFiles(input.files);
  if (input.postSlugs && input.postSlugs.length > MAX_FILES)
    throw new PresentonError(
      'invalid_input',
      `At most ${MAX_FILES} postSlugs per request`
    );
}

/**
 * 建任务行并启动生成，立即返回（不等待生成完成）。
 * 启动失败时任务行置 failed 并抛出错误；额度类错误会触发管理员提醒。
 */
export async function createJobAndStart(params: {
  ownerUserId: string;
  ownerTokenId?: string | null;
  input: GenerateInput;
}): Promise<PresentationJob> {
  const { ownerUserId, ownerTokenId, input } = params;
  validateGenerateInput(input);
  const { content, postTitles } = await assembleContent(input);
  const [job] = await db()
    .insert(presentationJob)
    .values({
      id: getUuid(),
      ownerUserId,
      ownerTokenId: ownerTokenId ?? null,
      status: 'queued',
      title: deriveTitle(input, postTitles),
    })
    .returning();
  try {
    const filePaths =
      input.files && input.files.length > 0
        ? await uploadFiles(input.files)
        : [];
    const language = (input.language || 'Chinese').trim() || 'Chinese';
    const template = (input.template || 'general').trim() || 'general';
    if (input.mode === 'smart') {
      const created = await presentonJson<{ id: string }>(
        '/api/v1/ppt/presentation/create',
        {
          content,
          n_slides: input.nSlides,
          language,
          file_paths: filePaths,
          tone: 'default',
          verbosity: 'standard',
          instructions: input.instructions,
          generation_mode: 'smart',
        }
      );
      if (!created?.id)
        throw new PresentonError(
          'presenton_error',
          'Presenton smart creation returned no id'
        );
      const updated = await updateJob(job.id, {
        status: 'generating',
        presentonId: created.id,
      });
      // detached：消费 stream 驱动生成；失败时由它自己把任务置 failed。
      void runSmartStream(job.id, created.id);
      return updated ?? job;
    }
    const { taskId, presentationId } = await startStandardGeneration({
      content,
      nSlides: input.nSlides,
      language,
      template,
      instructions: input.instructions,
      filePaths,
    });
    const updated = await updateJob(job.id, {
      status: 'generating',
      presentonId: presentationId,
      presentonTaskId: taskId,
    });
    return updated ?? job;
  } catch (error) {
    await failJob(job, error);
    throw error;
  }
}

/** 消费 smart stream 直到生成结束，成功则导出并完成任务，失败则置 failed。 */
const smartStreamsInFlight = new Set<string>();

async function runSmartStream(
  jobId: string,
  presentonId: string
): Promise<void> {
  if (smartStreamsInFlight.has(jobId)) return;
  smartStreamsInFlight.add(jobId);
  try {
    await consumeSmartStream(presentonId);
    const job = await getJob(jobId);
    if (!job || job.status !== 'generating') return;
    const pres = await getPresentation(presentonId);
    const slideCount = pres.slides?.length ?? 0;
    if (slideCount === 0)
      throw new PresentonError(
        'presenton_error',
        'Smart generation produced no slides'
      );
    const exported = await exportPresentation(presentonId);
    await completeJob(job, {
      title: pres.title,
      slideCount,
      exportPath: exported.path,
    });
  } catch (error) {
    const job = await getJob(jobId);
    if (job && job.status === 'generating') await failJob(job, error);
  } finally {
    smartStreamsInFlight.delete(jobId);
  }
}

/**
 * 单次刷新：查询 Presenton 看任务进展，有终态就写回任务行。
 * standard：查 async task 状态；smart：查 presentation 的 slides，出了
 * slides 就导出并完成；进程重启导致 stream 中断时，重新接上 stream。
 */
export async function refreshJob(
  job: PresentationJob
): Promise<PresentationJob> {
  if (job.status === 'completed' || job.status === 'failed') return job;
  try {
    if (job.presentonTaskId) {
      const task = await getTaskStatus(job.presentonTaskId);
      if (task.status === 'pending') return job;
      if (task.status === 'error') {
        const detail =
          typeof task.error === 'object' && task.error !== null
            ? JSON.stringify(task.error)
            : task.message || 'Presentation generation failed';
        const { code, message } = classifyError(undefined, detail);
        const failed = await failJob(
          job,
          new PresentonError(
            code,
            message,
            code === 'llm_quota_exceeded' ? 429 : 502
          )
        );
        return failed ?? job;
      }
      // completed：data 里带导出路径与 presentation id。
      const presentationId =
        task.data?.presentation_id || job.presentonId || '';
      const exportPath = task.data?.path;
      if (!presentationId || !exportPath)
        throw new PresentonError(
          'presenton_error',
          'Presenton task completed without a presentation id or export path'
        );
      const pres = await getPresentation(presentationId);
      const completed = await completeJob(job, {
        title: pres.title,
        slideCount: pres.slides?.length ?? 0,
        exportPath,
      });
      return completed ?? job;
    }
    if (job.presentonId) {
      const pres = await getPresentation(job.presentonId);
      const slideCount = pres.slides?.length ?? 0;
      if (slideCount > 0) {
        const exported = await exportPresentation(job.presentonId);
        const completed = await completeJob(job, {
          title: pres.title,
          slideCount,
          exportPath: exported.path,
        });
        return completed ?? job;
      }
      // 还没出 slides：stream 可能随进程重启中断了，重新接上。
      void runSmartStream(job.id, job.presentonId);
      return job;
    }
    return job;
  } catch (error) {
    // 刷新是 best-effort：Presenton 暂时不可达时保留 generating，下次再查。
    // 但额度类错误是终态信号，直接置 failed 并提醒。
    if (
      error instanceof PresentonError &&
      error.code === 'llm_quota_exceeded'
    ) {
      const failed = await failJob(job, error);
      return failed ?? job;
    }
    return job;
  }
}

/** 下载已完成任务的 pptx（只在服务端向 Presenton 取字节流）。 */
export async function downloadJobPptx(job: PresentationJob): Promise<Buffer> {
  if (job.status !== 'completed' || !job.exportPath)
    throw new PresentonError(
      'invalid_input',
      'Presentation is not ready for download'
    );
  return downloadPptxBytes(job.exportPath);
}
