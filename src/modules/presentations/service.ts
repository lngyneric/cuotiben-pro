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
import {
  notifyGenerationTimeout,
  notifyLlmQuotaExceeded,
} from '@/modules/notify/service';
import { getUuid } from '@/lib/hash';

import {
  autoChartType,
  CHART_TYPES,
  chartSummary,
  checkTypeMismatch,
  insertChart,
  insertKpiCards,
  parseChartAssignments,
  parseTableFile,
  readChartInfo,
  updateChart,
  validateChartData,
  validateKpiCards,
  VALUE_LABELS,
  type ChartAssignment,
  type ChartData,
  type ChartSpec,
  type ChartType,
  type KpiCard,
  type PageSourceRefInput,
  type ValueLabels,
} from './charts';
import {
  buildElementIndex,
  hasStampedElementIds,
  stampElementIds,
  type PptxElementIndex,
} from './element-index';
import { PresentonError, type PresentonErrorCode } from './errors';
import {
  markImagesUsed,
  parseImageDimensions,
  resolveImageBytes,
  resolveImageMappings,
  resolveImageRef,
  tryResolveLogo,
  type ImageMappingInput,
  type ImageViewer,
} from './images';
import {
  parseElementIndex,
  parseImageAssignments,
  parseLayoutAssignments,
  parsePageSourceRefs,
  serializeJobMeta,
  type ImageAssignment,
  type LayoutAssignment,
  type PageSourceRef,
} from './job-meta';
import {
  allSlots,
  buildThemeInstructions,
  findSlot,
  PPT_LOGO_SLOT,
  PPT_THEME_VERSION,
  type LayoutCode,
} from './layouts';
import {
  applyPageOps,
  describePageOps,
  getPageElements,
  validateRectIn,
  type PageEditOp,
  type RectIn,
} from './page-edit';
import {
  createPageVersion,
  getCurrentPageVersion,
  getPageVersion,
  readPageVersionBytes,
} from './page-versions';
import {
  assembleOutlineContent,
  getOwnedOutline,
  getOwnedSources,
  parseOutlinePages,
  type OutlinePage,
  type SourceOwner,
} from './sources';

export { PresentonError, type PresentonErrorCode } from './errors';

export type PresentationMode = 'standard' | 'smart';
export type PresentationJobStatus =
  | 'queued'
  | 'generating'
  | 'completed'
  | 'failed';
export const MAX_SLIDES = 50;
export const MAX_FILES = 10;
/** MCP/Execute 请求上限 2MB，base64 解码后总量不超 1.5MB。 */
export const MAX_TOTAL_FILE_BYTES = 1_500_000;
/** 拼进生成提示的素材上限（wiki 文章可能很长）。 */
export const MAX_ASSEMBLED_CONTENT_CHARS = 100_000;
/**
 * Presenton 版式（template）白名单：2026-11-22 对线上 Presenton
 * 0.9.12-beta 的 /api/v1/ppt/template/all 实测得到的 16 个内置版式
 *（id 即小写名）。generate/async 只认这些 id；smart 模式的 create
 * 接口不接受 template，版式只在标准模式生效。
 */
export const PRESENTATION_TEMPLATES = [
  'general',
  'momentum',
  'dynamic',
  'executive',
  'modern',
  'standard',
  'swift',
  'civic',
  'editorial',
  'horizon',
  'landmark',
  'mosaic',
  'nova',
  'pulse',
  'signal',
  'verdant',
] as const;
export type PresentationTemplate = (typeof PRESENTATION_TEMPLATES)[number];

const CONTROL_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const STREAM_TIMEOUT_MS = 10 * 60_000;

/**
 * 生成超时（阶段 1）：从任务受理起 600 秒未完成即置失败。600 秒取自跟踪器
 * 历史（2026-11-21 两次 smart 超时均为 600 秒整）。超时由 presentations_get
 * 的 refreshJob 发现（轮询时检查），smart 流中断由 runSmartStream 发现。
 * wiki 不配置模型名：Presenton/Magpie 用哪路模型由服务端定，日志里只记
 * 'magpie (Presenton default)'，不编一个具体模型 id。
 */
export const GENERATION_TIMEOUT_MS = 600_000;
export const PRESENTON_MODEL_LABEL = 'magpie (Presenton default)';

/**
 * Presenton 瞬时失败只重试一次，间隔 1 秒。2026-11-20 实测：smart /create
 * 在 17:04:19 得过一次 401（Presenton 中间件在 handler 前拒绝，未建 deck），
 * 4 分钟后同一把 key、同一接口直接 200。重试只覆盖“请求大概率未生效”的
 * 情况：401（中间件拒绝，未进 handler）、429、502/503/504，以及连不上
 * Presenton 的网络/超时错误。400/403/404/422 不重试；额度类
 * （llm_quota_exceeded）绝不重试。注意：网络错误重试时，第一次请求可能
 * 其实已在 Presenton 侧生效，重试会多建一个无主 deck——可接受，代价远小于
 * 直接让用户任务失败；无主 deck 不会被任何 wiki job 引用。
 */
const PRESENTON_MAX_ATTEMPTS = 2;
const PRESENTON_RETRY_DELAY_MS = 1000;
const RETRYABLE_PRESENTON_STATUSES = new Set([401, 429, 502, 503, 504]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryablePresentonStatus(status: number, text: string): boolean {
  if (!RETRYABLE_PRESENTON_STATUSES.has(status)) return false;
  // 429 可能是 Presenton 侧限流（可重试），也可能是 Magpie 额度耗尽（绝不重试）。
  return !isQuotaSignal(status, text);
}

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

export const PRESENTON_DEFAULT_BASE_URL = 'http://presenton-trial:80';

export interface PresentationFileInput {
  name: string;
  mime: string;
  base64: string;
}

export interface ChartInput {
  pageNo: number;
  slotId?: string;
  rectIn?: RectIn;
  chart: {
    title?: string;
    categories?: string[];
    series?: Array<{ name: string; values: number[] }>;
    chartType?: string;
    valueLabels?: string;
    sourceKind?: string;
    pageSourceRefs?: Array<{
      sourceId: string;
      sourceKind: string;
      locator: string;
    }>;
    file?: { name: string; mime: string; base64: string };
  };
  kpiCards?: Array<{
    title: string;
    value: number;
    unit?: string;
    fromData?: { series?: string; category?: string; agg?: string };
    pageSourceRefs?: Array<{
      sourceId: string;
      sourceKind: string;
      locator: string;
    }>;
    slotId?: string;
    rectIn?: RectIn;
  }>;
  /** 软冲突（类型与数据形态不合）时确认仍按指定类型画。 */
  confirm?: boolean;
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
  /** 阶段 1 内容源：已登记的来源 id；带来源生成必须同时给已确认的 outlineId。 */
  sourceIds?: string[];
  /** 阶段 1：已确认的页面划分草稿 id。 */
  outlineId?: string;
  /** 阶段 1 图片映射：imageId + 目标页 + 槽位（slotId 省略时用版式默认图片槽）。 */
  images?: ImageMappingInput[];
  /** 阶段 3 图表落图：每项指定页 + 图表数据（须先确认 outline，见 validateGenerateInput）。 */
  charts?: ChartInput[];
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
  for (let attempt = 1; attempt <= PRESENTON_MAX_ATTEMPTS; attempt++) {
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
      if (attempt < PRESENTON_MAX_ATTEMPTS) {
        console.warn(
          `[presentations] Presenton ${path} unreachable (attempt ${attempt}/${PRESENTON_MAX_ATTEMPTS}), retrying once`
        );
        await sleep(PRESENTON_RETRY_DELAY_MS);
        continue;
      }
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
    if (response.ok) return { status: response.status, text, json };
    if (
      attempt < PRESENTON_MAX_ATTEMPTS &&
      isRetryablePresentonStatus(response.status, text)
    ) {
      console.warn(
        `[presentations] Presenton ${path} HTTP ${response.status} (attempt ${attempt}/${PRESENTON_MAX_ATTEMPTS}), retrying once`
      );
      await sleep(PRESENTON_RETRY_DELAY_MS);
      continue;
    }
    const { code, message } = classifyError(response.status, text);
    throw new PresentonError(
      code,
      message,
      code === 'llm_quota_exceeded' ? 429 : 502
    );
  }
  // 循环内所有路径都会返回、继续或抛出；到这里只为满足类型检查。
  throw new PresentonError('presenton_error', 'Presenton request failed');
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
    // 流超时（AbortSignal.timeout 10 分钟）按生成超时处理，不归为笼统
    // 的 presenton_error：runSmartStream 据此走 generation_timeout 分支。
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    )
      throw new PresentonError(
        'generation_timeout',
        `Smart generation stream timed out after ${STREAM_TIMEOUT_MS / 1000}s`,
        504
      );
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
  error: unknown,
  opts?: { timeoutStage?: string }
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
  if (code === 'generation_timeout') {
    // 超时告警与额度告警同路（Notify + 每小时跟踪器扫 failed 任务），
    // 另落一条结构化日志，凭 job_id 可查（见 logGenerationTimeout）。
    const elapsedMs = Date.now() - new Date(job.createdAt).getTime();
    const stage = opts?.timeoutStage ?? 'polling';
    logGenerationTimeout({
      jobId: job.id,
      elapsedMs,
      promptChars: job.promptChars ?? null,
      stage,
    });
    await notifyGenerationTimeout({
      jobId: job.id,
      title: job.title || '',
      elapsedMs,
      stage,
    }).catch(() => {});
  }
  return updated;
}

/**
 * 超时结构化日志（阶段 1 清单字段）：job_id、耗时（受理到超时）、
 * 提示长度、所用模型；有阶段信息时记下卡在哪一步。跟踪器（每小时扫
 * presentation_job 的新失败任务）与 Notify 告警另走 failJob 的分支。
 */
export function logGenerationTimeout(params: {
  jobId: string;
  elapsedMs: number;
  promptChars: number | null;
  stage: string;
}): void {
  console.error(
    `[presentations][generation_timeout] ${JSON.stringify({
      job_id: params.jobId,
      elapsed_ms: params.elapsedMs,
      prompt_chars: params.promptChars,
      prompt_length: params.promptChars,
      model: PRESENTON_MODEL_LABEL,
      stage: params.stage,
    })}`
  );
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
  const sourced = !!input.sourceIds && input.sourceIds.length > 0;
  if (
    !input.content?.trim() &&
    (!input.files || input.files.length === 0) &&
    (!input.postSlugs || input.postSlugs.length === 0) &&
    !sourced &&
    !input.outlineId
  )
    throw new PresentonError(
      'invalid_input',
      'Provide content, files, postSlugs, or a confirmed outline (sourceIds + outlineId)'
    );
  if (
    sourced &&
    (input.content?.trim() || input.files?.length || input.postSlugs?.length)
  )
    throw new PresentonError(
      'invalid_input',
      '带来源生成时不要同时传 content/files/postSlugs：成稿只用已确认 outline 的来源片段'
    );
  if (input.images && input.images.length > 5)
    throw new PresentonError('invalid_input', '单次任务最多引用 5 张图片');
  if (input.charts && input.charts.length > 0) {
    if (input.charts.length > 5)
      throw new PresentonError('invalid_input', '单次任务最多落 5 个图表');
    if (!input.outlineId)
      throw new PresentonError(
        'invalid_input',
        '图表须先确认 outline：请先调用 presentations_outline 生成并确认页面划分，再带 charts 生成'
      );
  }
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
  if (
    input.template !== undefined &&
    !(PRESENTATION_TEMPLATES as readonly string[]).includes(input.template)
  )
    throw new PresentonError(
      'invalid_input',
      `Unknown template: ${input.template}`
    );
}

/**
 * 建任务行并启动生成，立即返回（不等待生成完成）。
 * 启动失败时任务行置 failed 并抛出错误；额度类错误会触发管理员提醒。
 *
 * 阶段 1：带来源生成（sourceIds + 已确认的 outlineId）时，内容只用
 * outline 每页的来源片段组装，版式与留痕（layoutAssignments /
 * pageSourceRefs）随任务保存；无来源时保持现行纯提示词，但结果中标注
 * “无来源生成”（presentations_get 的 sourceMode）。图片映射（images）
 * 必须有已确认的 outline（槽位取自该页版式）；Logo 按 tryResolveLogo
 * 的结果处理（见 images.ts：当前无光栅 Logo 文件可注）。
 */
export async function createJobAndStart(params: {
  ownerUserId: string;
  ownerTokenId?: string | null;
  isAdmin?: boolean;
  input: GenerateInput;
}): Promise<PresentationJob> {
  const { ownerUserId, ownerTokenId, input } = params;
  const owner = { userId: ownerUserId, tokenId: ownerTokenId ?? null };
  const viewer = { ...owner, isAdmin: params.isAdmin ?? false };
  validateGenerateInput(input);
  let content: string;
  let title: string;
  let layoutAssignments: LayoutAssignment[] | null = null;
  let pageSourceRefs: PageSourceRef[] | null = null;
  let outlinePages: ReturnType<typeof parseOutlinePages> = null;
  if (input.outlineId || (input.sourceIds && input.sourceIds.length > 0)) {
    if (!input.outlineId)
      throw new PresentonError(
        'invalid_input',
        '带来源生成须先调用 presentations_outline 生成并确认页面划分，再带 outline_id 生成'
      );
    const outline = await getOwnedOutline(input.outlineId, owner);
    if (outline.status !== 'confirmed')
      throw new PresentonError(
        'invalid_input',
        '页面划分草稿尚未确认：请先确认 outline 再生成'
      );
    const outlineSourceIds = JSON.parse(outline.sourceIds) as string[];
    if (input.sourceIds && input.sourceIds.length > 0) {
      const a = [...input.sourceIds].sort();
      const b = [...outlineSourceIds].sort();
      if (a.length !== b.length || a.some((v, i) => v !== b[i]))
        throw new PresentonError(
          'invalid_input',
          'source_ids 与已确认 outline 登记的来源不一致'
        );
    }
    const sources = await getOwnedSources(outlineSourceIds, owner);
    const sourcesById = new Map(sources.map((s) => [s.id, s]));
    const assembled = assembleOutlineContent(outline, sourcesById);
    content = assembled.content;
    layoutAssignments = assembled.layoutAssignments;
    pageSourceRefs = assembled.pageSourceRefs;
    outlinePages = parseOutlinePages(outline.pages);
    if (!outlinePages)
      throw new PresentonError('invalid_input', '页面划分草稿数据损坏');
    if (input.nSlides !== undefined && input.nSlides !== outlinePages.length)
      throw new PresentonError(
        'invalid_input',
        `nSlides（${input.nSlides}）与已确认的页面划分（${outlinePages.length} 页）不一致`
      );
    title = outlinePages[0]?.title ?? 'PPT';
  } else {
    const assembled = await assembleContent(input);
    content = assembled.content;
    title = deriveTitle(input, assembled.postTitles);
  }
  if (input.images && input.images.length > 0 && !outlinePages)
    throw new PresentonError(
      'invalid_input',
      '配图须先确认 outline：请先调用 presentations_outline 生成并确认页面划分，再带 images 生成'
    );
  // 主题与 Logo 注入（唯一注入点，见 layouts.ts）：Presenton 的生成接口
  // 不接受主题色/Logo 参数，注入只能走 instructions 文本。用户自填的
  // instructions 在前，主题块在后；标准与 smart 两个模式共用同一份。
  const themeInstructions = buildThemeInstructions();
  const instructions = [input.instructions?.trim(), themeInstructions]
    .filter(Boolean)
    .join('\n\n');
  // 图片：先解析映射（槽位校验 + low_res 判定），生成时再取字节上传。
  let imageAssignments: ImageAssignment[] = [];
  let imageFiles: PresentationFileInput[] = [];
  let imageInstructions = '';
  if (input.images && input.images.length > 0 && outlinePages) {
    const mapped = await resolveImageMappings(
      viewer,
      outlinePages,
      input.images
    );
    imageAssignments = mapped.assignments;
    const instructionLines: string[] = [];
    for (const a of imageAssignments) {
      const ref = await resolveImageRef(viewer, a.imageId);
      const bytes = await resolveImageBytes(ref);
      if (!bytes) {
        // 取不到图字节：该槽位留空，任务结果列明缺图，不拿别图顶替。
        a.missing = true;
        a.missingReason = '图片文件无法取到（存储不可达或外域地址），槽位留空';
        continue;
      }
      const uploadName = `img-p${a.pageNo}-${a.slotId}-${a.fileName}`.replace(
        /[^A-Za-z0-9._-]+/g,
        '_'
      );
      imageFiles.push({
        name: uploadName,
        mime: bytes.mime,
        base64: bytes.bytes.toString('base64'),
      });
      const slot = allSlots(
        outlinePages.find((p) => p.pageNo === a.pageNo)!.layout
      ).find((s) => s.id === a.slotId)!;
      instructionLines.push(
        `第 ${a.pageNo} 页：图片「${uploadName}」放入 ${a.slotId} 槽位（x=${slot.rectIn.x}in, y=${slot.rectIn.y}in, ${slot.rectIn.width}×${slot.rectIn.height} 英寸），按比例裁切填充（cover），禁止拉伸变形。` +
          (a.lowRes
            ? '注意：该图分辨率低于槽位要求（low_res），请勿放大，居中放置。'
            : '')
      );
    }
    if (instructionLines.length > 0) {
      imageInstructions = `【配图要求】\n${instructionLines.join('\n')}`;
    }
    await markImagesUsed(
      imageAssignments.filter((a) => !a.missing).map((a) => a.imageId)
    ).catch(() => {});
  }
  // 阶段 3 图表：生成时只解析与校验（数据来源三选一、类型冲突、
  // 数字卡同源），落图在任务完成时由 applyGenerateCharts 做（那时
  // 才有 Presenton 成稿）；落图明细存 chart_assignments 列。
  let chartAssignments: ChartAssignment[] = [];
  let chartInstructions = '';
  if (input.charts && input.charts.length > 0 && outlinePages) {
    const layoutStub = {
      layoutAssignments: serializeJobMeta(layoutAssignments ?? []),
    } as PresentationJob;
    const lines: string[] = [];
    for (const raw of input.charts) {
      const normalized = await normalizeChartAssignment(
        raw,
        layoutStub,
        outlinePages,
        owner,
        raw.confirm === true
      );
      if ('proposal' in normalized)
        throw new PresentonError(
          'invalid_input',
          `${normalized.proposal.reason}（建议类型：${normalized.proposal.suggestedType}）`
        );
      chartAssignments.push(normalized.assignment);
      const a = normalized.assignment;
      lines.push(
        `第 ${a.pageNo} 页是图表页：只留标题与要点文字，不要画图表或配图（图表由 wiki 在生成后按数据落入：${a.chart.chartType}${a.chart.chartTypeAuto ? '（按数据形态自动选型）' : ''}，标签 ${a.chart.valueLabels}${a.kpiCards?.length ? `，另有 ${a.kpiCards.length} 张数字卡` : ''}）。`
      );
    }
    if (lines.length > 0)
      chartInstructions = `【图表页要求】\n${lines.join('\n')}`;
  }
  // Logo：有光栅文件时随图一起上传、按注册表 Logo 位落位；没有时不编造。
  let logoInstruction = '';
  const logo = await tryResolveLogo().catch(() => null);
  if (logo) {
    imageFiles.push({
      name: logo.name,
      mime: logo.mime,
      base64: logo.bytes.toString('base64'),
    });
    logoInstruction =
      `Logo 图片「${logo.name}」固定放在右上角（x=${PPT_LOGO_SLOT.x}in, ` +
      `y=${PPT_LOGO_SLOT.y}in, ${PPT_LOGO_SLOT.width}×${PPT_LOGO_SLOT.height} 英寸），标题区不得压住 Logo。`;
  }
  const fullInstructions = [
    instructions,
    imageInstructions,
    chartInstructions,
    logoInstruction,
  ]
    .filter(Boolean)
    .join('\n\n');
  const [job] = await db()
    .insert(presentationJob)
    .values({
      id: getUuid(),
      ownerUserId,
      ownerTokenId: ownerTokenId ?? null,
      status: 'queued',
      title,
      themeVersion: PPT_THEME_VERSION,
      ...(layoutAssignments
        ? { layoutAssignments: serializeJobMeta(layoutAssignments) }
        : {}),
      ...(pageSourceRefs
        ? { pageSourceRefs: serializeJobMeta(pageSourceRefs) }
        : {}),
      ...(imageAssignments.length > 0
        ? { imageAssignments: serializeJobMeta(imageAssignments) }
        : {}),
      ...(chartAssignments.length > 0
        ? { chartAssignments: serializeJobMeta(chartAssignments) }
        : {}),
      promptChars: content.length + fullInstructions.length,
    })
    .returning();
  try {
    const filePaths =
      input.files && input.files.length > 0
        ? await uploadFiles(input.files)
        : [];
    const imagePaths =
      imageFiles.length > 0 ? await uploadFiles(imageFiles) : [];
    const allFilePaths = [...filePaths, ...imagePaths];
    const language = (input.language || 'Chinese').trim() || 'Chinese';
    const template = (input.template || 'general').trim() || 'general';
    if (input.mode === 'smart') {
      const created = await presentonJson<{ id: string }>(
        '/api/v1/ppt/presentation/create',
        {
          content,
          n_slides: input.nSlides,
          language,
          file_paths: allFilePaths,
          tone: 'default',
          verbosity: 'standard',
          instructions: fullInstructions,
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
      instructions: fullInstructions,
      filePaths: allFilePaths,
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
    // 阶段 3：生成时登记的图表在成稿出来后落图。注意外层 catch 只处理
    // generating 态的失败（任务已 completed 时它会直接 return），
    // 所以落图失败在这里直接置 failed，不走外层 catch。
    const freshSmartJob = await getJob(jobId);
    if (freshSmartJob) {
      try {
        await applyGenerateCharts(freshSmartJob);
      } catch (error) {
        await failJob(freshSmartJob, error);
        return;
      }
    }
  } catch (error) {
    const job = await getJob(jobId);
    if (!job || job.status !== 'generating') return;
    // stream 超时（consumeSmartStream 已转成 generation_timeout）按生成
    // 超时处理，阶段记 smart-stream；其余错误沿用原有失败路径。
    if (
      error instanceof PresentonError &&
      error.code === 'generation_timeout'
    ) {
      await failJob(job, error, { timeoutStage: 'smart-stream' });
      return;
    }
    await failJob(job, error);
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
  // 超时判定（阶段 1）：受理超过 GENERATION_TIMEOUT_MS 仍未完成，置失败
  // 并落结构化日志 + Notify（failJob 的 generation_timeout 分支）。
  // 发现时机是下一次 presentations_get 轮询；每小时跟踪器扫到该失败
  // 任务后上报，与 Magpie 额度告警同路。
  if (Date.now() - new Date(job.createdAt).getTime() > GENERATION_TIMEOUT_MS) {
    const elapsedMs = Date.now() - new Date(job.createdAt).getTime();
    const failed = await failJob(
      job,
      new PresentonError(
        'generation_timeout',
        `Generation timed out after ${Math.round(elapsedMs / 1000)}s (limit ${GENERATION_TIMEOUT_MS / 1000}s)`,
        504
      ),
      { timeoutStage: 'polling' }
    );
    return failed ?? job;
  }
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
      // 阶段 3：生成时登记的图表在成稿出来后落图；落图失败则任务置
      // failed（图表没落进去的稿子不冒充“带图完成”）。
      const done = completed ?? job;
      try {
        await applyGenerateCharts(done);
      } catch (error) {
        const failed = await failJob(
          done,
          error instanceof PresentonError
            ? error
            : new PresentonError(
                'presenton_error',
                error instanceof Error ? error.message : '图表落图失败'
              )
        );
        return failed ?? job;
      }
      return done;
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
        const done = completed ?? job;
        try {
          await applyGenerateCharts(done);
        } catch (error) {
          const failed = await failJob(
            done,
            error instanceof PresentonError
              ? error
              : new PresentonError(
                  'presenton_error',
                  error instanceof Error ? error.message : '图表落图失败'
                )
          );
          return failed ?? job;
        }
        return done;
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

/**
 * 下载已完成任务的 pptx（只在服务端向 Presenton 取字节流）。
 *
 * element_id 落地（阶段 0，见 element-index.ts）：Presenton 不提供给形状
 * 写 ID 的接口，wiki 在下载时把稳定 ID 写进每个形状的 <p:cNvPr name>，
 * 并把逐页元素索引缓存到任务行的 element_index 列。盖章是 best-effort：
 * 盖不上（不是合法 PPTX）时原样返回原字节，下载不受影响；缓存写失败
 * 也不影响下载。
 *
 * 阶段 2：已有编辑版本时下载取最新版本的文件，不再向 Presenton 取原稿；
 * 无编辑版本时走原逻辑（实时取原稿 + 盖章）。
 */
export async function downloadJobPptx(job: PresentationJob): Promise<Buffer> {
  if (job.status !== 'completed' || !job.exportPath)
    throw new PresentonError(
      'invalid_input',
      'Presentation is not ready for download'
    );
  const currentVersion = await getCurrentPageVersion(job.id);
  if (currentVersion > 0) {
    const row = await getPageVersion(job.id, currentVersion);
    const bytes = row ? await readPageVersionBytes(row) : null;
    if (!bytes)
      throw new PresentonError(
        'presenton_error',
        '已编辑的版本文件丢失，无法下载当前版本'
      );
    return bytes;
  }
  return downloadOriginalPptx(job);
}

/**
 * 向 Presenton 取原稿并顺手盖 element_id（下载与单页编辑的共同入口）。
 * 盖不上章时原样返回原字节——下载不受影响；编辑入口另有严格校验
 * （getJobCurrentBytes 会明确拒绝无 element_id 的旧稿）。
 */
async function downloadOriginalPptx(job: PresentationJob): Promise<Buffer> {
  const bytes = await downloadPptxBytes(job.exportPath!);
  const stamped = stampElementIds(bytes);
  if (!stamped) return bytes;
  await updateJob(job.id, {
    elementIndex: serializeJobMeta(stamped.index),
  }).catch(() => {});
  return stamped.bytes;
}

/**
 * 单页编辑用的当前版本字节：有编辑版本时取最新版本文件；无编辑版本时
 * 取原稿，但要求能确立 element_id——解析不出或未带 ID 的历史旧稿明确
 * 拒绝（legacy_not_supported），不假装可改、不静默改文件。
 */
export async function getJobCurrentBytes(
  job: PresentationJob
): Promise<Buffer> {
  const currentVersion = await getCurrentPageVersion(job.id);
  if (currentVersion > 0) {
    const row = await getPageVersion(job.id, currentVersion);
    const bytes = row ? await readPageVersionBytes(row) : null;
    if (!bytes)
      throw new PresentonError(
        'presenton_error',
        '已编辑的版本文件丢失，无法读取当前版本'
      );
    return bytes;
  }
  const bytes = await downloadOriginalPptx(job);
  // 能盖上章的一定已带 ID；盖不上（解析不出、或形状名里没有 ID）的一
  // 律按历史旧稿处理：明确回不支持，不假装可改、不静默改文件。
  const stamped = hasStampedElementIds(bytes);
  if (stamped !== true)
    throw new PresentonError(
      'legacy_not_supported',
      '旧稿不支持单页编辑：该稿未带 element_id 或无法解析元素结构，请用新生成的稿子再改'
    );
  return bytes;
}

/**
 * 逐页元素可按 ID 列出（阶段 0 完成标志之一，供阶段 2 单页编辑定位）。
 * 优先读任务行缓存的 element_index；没有缓存时现算一次并写回。
 * 只对已完成任务提供；未完成时与下载一致报 not ready。
 */
export async function listJobElements(
  job: PresentationJob
): Promise<PptxElementIndex> {
  if (job.status !== 'completed' || !job.exportPath)
    throw new PresentonError(
      'invalid_input',
      'Presentation is not ready for download'
    );
  // 阶段 2：已有编辑版本时索引从最新版本文件现算，不再向 Presenton 取原稿。
  const currentVersion = await getCurrentPageVersion(job.id);
  if (currentVersion > 0) {
    const row = await getPageVersion(job.id, currentVersion);
    const bytes = row ? await readPageVersionBytes(row) : null;
    if (!bytes)
      throw new PresentonError(
        'presenton_error',
        '已编辑的版本文件丢失，无法读取元素'
      );
    const versionIndex = buildElementIndex(bytes);
    if (!versionIndex)
      throw new PresentonError(
        'presenton_error',
        'Cannot read elements from the presentation file'
      );
    await updateJob(job.id, {
      elementIndex: serializeJobMeta(versionIndex),
    }).catch(() => {});
    return versionIndex;
  }
  const cached = parseElementIndex(job.elementIndex);
  if (cached) return cached;
  const bytes = await downloadPptxBytes(job.exportPath);
  const stamped = stampElementIds(bytes);
  const index = stamped?.index ?? buildElementIndex(bytes);
  if (!index)
    throw new PresentonError(
      'presenton_error',
      'Cannot read elements from the presentation file'
    );
  await updateJob(job.id, {
    elementIndex: serializeJobMeta(index),
  }).catch(() => {});
  return index;
}

// ─── 留痕视图（阶段 1） ─────────────────────────────────────────────────────

/**
 * 任务的来源/版式/图片留痕（MCP presentations_get 与页面查询共用）：
 * - sourceMode：'sourced'（带已确认 outline 生成）或 'unsourced'
 *   （纯提示词，結果中标注“无来源生成”）。
 * - missingImagePages：有图片槽位、但未配上可用图的页码（“第 N 页缺图”）。
 */
export function jobProvenanceView(job: PresentationJob): {
  sourceMode: 'sourced' | 'unsourced';
  layoutAssignments: LayoutAssignment[] | null;
  pageSourceRefs: PageSourceRef[] | null;
  imageAssignments: ImageAssignment[] | null;
  chartAssignments: ChartAssignment[] | null;
  missingImagePages: number[];
} {
  const layoutAssignments = parseLayoutAssignments(job.layoutAssignments);
  const pageSourceRefs = parsePageSourceRefs(job.pageSourceRefs);
  const imageAssignments = parseImageAssignments(job.imageAssignments);
  const chartAssignments = parseChartAssignments(job.chartAssignments);
  const missingImagePages: number[] = [];
  if (layoutAssignments) {
    const covered = new Set(
      (imageAssignments ?? []).filter((a) => !a.missing).map((a) => a.pageNo)
    );
    for (const la of layoutAssignments) {
      if (covered.has(la.pageNo)) continue;
      const hasImageSlot = allSlots(la.layout).some(
        (s) => s.type === 'main_image' || s.type === 'small_image'
      );
      if (hasImageSlot) missingImagePages.push(la.pageNo);
    }
  }
  return {
    sourceMode: pageSourceRefs ? 'sourced' : 'unsourced',
    layoutAssignments,
    pageSourceRefs,
    imageAssignments,
    chartAssignments,
    missingImagePages,
  };
}

// ─── 阶段 2：单页编辑 ────────────────────────────────────────────────────────
//
// 流程（实施清单能力三）：
// 1. presentations_page_get 取指定页的元素清单（element_id、类型、当前
//    文字/属性、所在槽位），口述改稿先经此清单定位，不靠猜坐标。
// 2. presentations_page_edit 改一页：口述 ops 直接执行；截图模式
//    （referenceImageId）与删除/换图类操作先走 planPageEdit 产出拟改动
//    清单，用户确认（confirm=true）后才执行。服务端只重写该页，其余页
//    逐字节保留（page-edit.ts 的 zip 手术），执行后版本号递增。
// 3. presentations_page_revert 按版本号回退：另起一版、内容复制目标版
//    本，不删行，下载随之指向回退版。
// 单页预览：服务器容器内没有 LibreOffice / pdftoppm 等渲染工具（2026-11-25
// 实查：which soffice/libreoffice/pdftoppm 均无），所以 preview 不是图片，
// 而是改后单页的元素清单 + 已应用的操作摘要——如实返回，不编造渲染图。
// 截图识别：服务端没有视觉模型，参考图的版式/颜色/位置/文字差异由调用
// 方 agent（有视觉能力）对照 page_get 清单识别后下发 ops；服务端只校验
// reference_image 存在且调用方可见、ops 逐项可执行，并先出拟改动清单。

function invalidInput(message: string): never {
  throw new PresentonError('invalid_input', message);
}

function asNonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim())
    invalidInput(`${what}须为非空字符串`);
  return (value as string).trim();
}

/** move/resize/add/replace_image 的目标矩形：slotId（查版式注册表）或明确 rectIn。 */
function resolveTargetRect(
  job: PresentationJob,
  pageNo: number,
  raw: Record<string, unknown>
): RectIn {
  if (typeof raw.slotId === 'string' && raw.slotId.trim()) {
    const slotId = raw.slotId.trim();
    const layouts = parseLayoutAssignments(job.layoutAssignments);
    const layoutCode = layouts?.find((l) => l.pageNo === pageNo)?.layout;
    if (!layoutCode)
      invalidInput(
        `第 ${pageNo} 页没有版式记录，无法按槽位 ${slotId} 定位：请给明确矩形 rectIn`
      );
    const slot = findSlot(layoutCode, slotId);
    if (!slot)
      invalidInput(`第 ${pageNo} 页的版式 ${layoutCode} 没有槽位 ${slotId}`);
    return { ...slot.rectIn };
  }
  if (raw.rectIn !== undefined) return validateRectIn(raw.rectIn, '目标位置');
  invalidInput('须给出 slotId（版式槽位）或 rectIn（明确矩形，英寸）');
}

const IMAGE_MIME_TO_EXT: Record<string, 'png' | 'jpg' | 'gif' | 'webp'> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * 把 MCP / 页面传来的原始 ops 规整成 PageEditOp：逐项校验形态、把 slotId
 * 解析成 rectIn、把 replace_image 的 image_id 解析成图片字节与尺寸。
 * 不写任何文件（plan 与 apply 共用）。
 */
export async function normalizePageOps(
  job: PresentationJob,
  pageNo: number,
  rawOps: unknown,
  viewer: ImageViewer
): Promise<PageEditOp[]> {
  if (!Array.isArray(rawOps) || rawOps.length === 0 || rawOps.length > 20)
    invalidInput('操作列表须为 1–20 个操作');
  const out: PageEditOp[] = [];
  for (const raw of rawOps as unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      invalidInput('每个操作须为对象');
    const r = raw as Record<string, unknown>;
    switch (r.op) {
      case 'set_text': {
        const text = r.text;
        if (typeof text !== 'string' || text.length > 5000)
          invalidInput('set_text 的文字须为字符串且不超过 5000 字');
        out.push({
          op: 'set_text',
          elementId: asNonEmptyString(r.elementId, 'elementId'),
          text,
        });
        break;
      }
      case 'set_style': {
        const align = r.align;
        if (
          align !== undefined &&
          align !== 'left' &&
          align !== 'center' &&
          align !== 'right'
        )
          invalidInput('align 只接受 left、center、right');
        const fontSizePt = r.fontSizePt;
        if (
          fontSizePt !== undefined &&
          (typeof fontSizePt !== 'number' || !Number.isFinite(fontSizePt))
        )
          invalidInput('fontSizePt 须为数字（单位 pt）');
        out.push({
          op: 'set_style',
          elementId: asNonEmptyString(r.elementId, 'elementId'),
          ...(typeof r.color === 'string' ? { color: r.color } : {}),
          ...(r.explicitColor === true ? { explicitColor: true } : {}),
          ...(fontSizePt !== undefined
            ? { fontSizePt: fontSizePt as number }
            : {}),
          ...(typeof r.bold === 'boolean' ? { bold: r.bold } : {}),
          ...(align !== undefined
            ? { align: align as 'left' | 'center' | 'right' }
            : {}),
        });
        break;
      }
      case 'move':
      case 'resize': {
        out.push({
          op: r.op,
          elementId: asNonEmptyString(r.elementId, 'elementId'),
          rectIn: resolveTargetRect(job, pageNo, r),
        });
        break;
      }
      case 'replace_image': {
        const imageId = asNonEmptyString(r.imageId, 'imageId');
        const ref = await resolveImageRef(viewer, imageId);
        const resolved = await resolveImageBytes(ref);
        if (!resolved)
          invalidInput(
            `图片 ${imageId} 无法取到（存储不可达或外域地址），不能换图`
          );
        const ext = IMAGE_MIME_TO_EXT[resolved.mime];
        if (!ext)
          invalidInput(`图片 ${imageId} 的类型 ${resolved.mime} 不支持换图`);
        const dims = parseImageDimensions(resolved.bytes, ext);
        const rectIn =
          typeof r.slotId === 'string' || r.rectIn !== undefined
            ? resolveTargetRect(job, pageNo, r)
            : undefined;
        out.push({
          op: 'replace_image',
          elementId: asNonEmptyString(r.elementId, 'elementId'),
          image: {
            bytes: resolved.bytes,
            ext,
            width: dims?.width ?? null,
            height: dims?.height ?? null,
          },
          ...(rectIn ? { rectIn } : {}),
        });
        break;
      }
      case 'add_element': {
        const kind = r.kind === 'shape' ? 'shape' : 'text';
        if (kind === 'text' && typeof r.text !== 'string')
          invalidInput('新增文字元素须给出文字');
        const fontSizePt = r.fontSizePt;
        if (
          fontSizePt !== undefined &&
          (typeof fontSizePt !== 'number' || !Number.isFinite(fontSizePt))
        )
          invalidInput('fontSizePt 须为数字（单位 pt）');
        out.push({
          op: 'add_element',
          kind,
          ...(kind === 'text' ? { text: r.text as string } : {}),
          rectIn: resolveTargetRect(job, pageNo, r),
          ...(typeof r.color === 'string' ? { color: r.color } : {}),
          ...(r.explicitColor === true ? { explicitColor: true } : {}),
          ...(fontSizePt !== undefined
            ? { fontSizePt: fontSizePt as number }
            : {}),
          ...(typeof r.bold === 'boolean' ? { bold: r.bold } : {}),
        });
        break;
      }
      case 'delete_element': {
        out.push({
          op: 'delete_element',
          elementId: asNonEmptyString(r.elementId, 'elementId'),
        });
        break;
      }
      default:
        invalidInput(`未知操作：${String(r.op)}`);
    }
  }
  return out;
}

function jobLayoutCode(
  job: PresentationJob,
  pageNo: number
): LayoutCode | null {
  const layouts = parseLayoutAssignments(job.layoutAssignments);
  return layouts?.find((l) => l.pageNo === pageNo)?.layout ?? null;
}

/** 取指定页的元素清单（page_get）：元素 + 所在槽位 + 是否可编辑 + 当前版本。 */
export async function getPageElementList(
  job: PresentationJob,
  pageNo: number
): Promise<{
  jobId: string;
  pageNo: number;
  slideCount: number | null;
  layout: string | null;
  currentVersion: number;
  editable: boolean;
  editableNote: string | null;
  elements: ReturnType<typeof getPageElements>['elements'];
}> {
  if (!Number.isInteger(pageNo) || pageNo < 1)
    invalidInput('pageNo 须为正整数');
  if (job.slideCount !== null && pageNo > job.slideCount)
    invalidInput(`第 ${pageNo} 页不存在（本稿共 ${job.slideCount} 页）`);
  const currentVersion = await getCurrentPageVersion(job.id);
  const bytes =
    currentVersion > 0
      ? await getJobCurrentBytes(job)
      : await downloadOriginalPptx(job);
  const layoutCode = jobLayoutCode(job, pageNo);
  const view = getPageElements(bytes, pageNo, layoutCode);
  return {
    jobId: job.id,
    pageNo,
    slideCount: job.slideCount,
    layout: layoutCode,
    currentVersion,
    editable: view.editable,
    editableNote: view.editable
      ? null
      : '该稿未带 element_id（历史旧稿），不支持单页编辑',
    elements: view.elements,
  };
}

/** 拟改动清单（不写文件）：校验 ops 逐项可执行，并回显每项改什么。 */
export async function planPageEdit(
  job: PresentationJob,
  pageNo: number,
  rawOps: unknown,
  viewer: ImageViewer,
  referenceImageId?: string
): Promise<{
  jobId: string;
  pageNo: number;
  currentVersion: number;
  wouldBeVersion: number;
  requiresConfirmation: true;
  referenceImageId: string | null;
  changes: Awaited<ReturnType<typeof describePageOps>>;
}> {
  if (referenceImageId) {
    // 参考图只校验存在与可见性（走能力一的 image_id 体系）；图里“改什么”
    // 由调用方 agent 对照 page_get 清单识别后下发 ops，服务端不猜。
    await resolveImageRef(viewer, referenceImageId);
  }
  const ops = await normalizePageOps(job, pageNo, rawOps, viewer);
  const bytes = await getJobCurrentBytes(job);
  const changes = describePageOps(bytes, pageNo, ops);
  const currentVersion = await getCurrentPageVersion(job.id);
  return {
    jobId: job.id,
    pageNo,
    currentVersion,
    wouldBeVersion: currentVersion + 1,
    requiresConfirmation: true,
    referenceImageId: referenceImageId ?? null,
    changes,
  };
}

/**
 * 执行单页编辑：只重写该页，写新版本文件 + 版本行，更新元素索引缓存，
 * 返回改后单页预览（元素清单，非图片——见本节头部说明）与新版本号。
 * 调用方须先确认：截图模式与删除/换图类操作在 handler 层先走 plan。
 */
export async function applyPageEdit(
  job: PresentationJob,
  pageNo: number,
  rawOps: unknown,
  viewer: ImageViewer,
  opts?: { referenceImageId?: string }
): Promise<{
  jobId: string;
  pageNo: number;
  version: number;
  applied: Awaited<ReturnType<typeof describePageOps>>;
  pagePreview: {
    rendered: false;
    note: string;
    elements: ReturnType<typeof getPageElements>['elements'];
  };
}> {
  const ops = await normalizePageOps(job, pageNo, rawOps, viewer);
  const bytes = await getJobCurrentBytes(job);
  const { bytes: newBytes, applied, index } = applyPageOps(bytes, pageNo, ops);
  const currentVersion = await getCurrentPageVersion(job.id);
  const version = currentVersion + 1;
  await createPageVersion({
    jobId: job.id,
    version,
    pageNo,
    ops,
    bytes: newBytes,
  });
  await updateJob(job.id, {
    elementIndex: serializeJobMeta(index),
  }).catch(() => {});
  const layoutCode = jobLayoutCode(job, pageNo);
  const preview = getPageElements(newBytes, pageNo, layoutCode);
  return {
    jobId: job.id,
    pageNo,
    version,
    applied,
    pagePreview: {
      rendered: false,
      note: '服务端容器内无 LibreOffice 等渲染工具，单页预览为改后元素清单（非图片）；请在 PowerPoint 中打开下载文件核对',
      elements: preview.elements,
    },
  };
}

/**
 * 按版本号回退：另起一版、内容复制目标版本（targetVersion 0 = 原稿），
 * 不删旧行；下载随之指向回退版。只能回退到比当前版本小的已有版本。
 */
export async function revertPageEdit(
  job: PresentationJob,
  targetVersion: number
): Promise<{
  jobId: string;
  version: number;
  revertedTo: number;
  pageNo: number;
}> {
  if (!Number.isInteger(targetVersion) || targetVersion < 0)
    invalidInput('回退版本号须为 ≥0 的整数');
  const currentVersion = await getCurrentPageVersion(job.id);
  if (currentVersion === 0) invalidInput('本稿还没有任何编辑版本，无可回退');
  if (targetVersion >= currentVersion)
    invalidInput(
      `只能回退到比当前版本 ${currentVersion} 小的已有版本（0 = 原稿）`
    );
  let bytes: Buffer;
  let pageNo = 0;
  if (targetVersion === 0) {
    bytes = await downloadOriginalPptx(job);
  } else {
    const row = await getPageVersion(job.id, targetVersion);
    if (!row) invalidInput(`没有版本 ${targetVersion}`);
    const found = await readPageVersionBytes(row);
    if (!found)
      throw new PresentonError(
        'presenton_error',
        `版本 ${targetVersion} 的文件丢失，无法回退`
      );
    bytes = found;
    pageNo = row.pageNo;
  }
  const version = currentVersion + 1;
  await createPageVersion({
    jobId: job.id,
    version,
    pageNo,
    ops: [
      { op: 'revert', fromVersion: currentVersion, toVersion: targetVersion },
    ],
    bytes,
  });
  const index = buildElementIndex(bytes);
  if (index)
    await updateJob(job.id, {
      elementIndex: serializeJobMeta(index),
    }).catch(() => {});
  return { jobId: job.id, version, revertedTo: targetVersion, pageNo };
}

/** 供 presentations_get 回显的当前编辑版本号（无编辑时为 0）。 */
export async function getJobPageVersion(job: PresentationJob): Promise<number> {
  return getCurrentPageVersion(job.id);
}

// ─── 阶段 3：图表与 Dashboard ───────────────────────────────────────────────
//
// 流程（实施清单能力四）：
// 1. presentations_chart_add：在已完成稿子的指定页、指定槽位插入一个
//    原生图表（charts.ts 的 zip 手术：chart 部件＋内嵌 xlsx 工作簿）。
//    数据来源只限三路——用户直接贴数、上传 csv/xlsx 中指定的表、内容源
//    中带出处的数据（须带 pageSourceRefs）；三者之外不取数，无数据时
//    明确回“缺数据”并停止，不编示例数字。
// 2. presentations_chart_update：改已有图表（换数据、换类型、切数值
//    标签显隐），走单页编辑通道，只动该图表所在页（只改 chart 部件＋
//    必要时内嵌工作簿，slide XML 不动，其余页逐字节保留）。
// 3. 生成时带 charts：outline 里某页标记为 chart/dashboard 页时，
//    生成阶段登记落图明细（chart_assignments 列），成稿一出就由
//    applyGenerateCharts 落图并存为版本（与文字页同批产出）。
// 类型冲突：指定类型与数据形态明显不合时先返回拟确认清单
// （requiresConfirmation + suggestedType），带 confirm=true 才按指定
// 执行，不静默换型；饼/环形多系列或负值是硬错，直接拒绝。
// 单页预览与阶段 2 同口径：改后单页元素清单（非渲染图），服务器容器
// 内无渲染工具，不编造渲染图。

export interface ChartMismatchProposal {
  requiresConfirmation: true;
  requestedType: ChartType;
  suggestedType: ChartType;
  reason: string;
}

function asPageSourceRefs(value: unknown, what: string): PageSourceRefInput[] {
  if (!Array.isArray(value) || value.length === 0)
    invalidInput(
      `${what}须给出非空的 page_source_refs（sourceId + sourceKind + locator）`
    );
  const out: PageSourceRefInput[] = [];
  for (const r of value as unknown[]) {
    if (typeof r !== 'object' || r === null || Array.isArray(r))
      invalidInput(`${what}的每项来源引用须为对象`);
    const rec = r as Record<string, unknown>;
    if (
      typeof rec.sourceId !== 'string' ||
      !rec.sourceId.trim() ||
      typeof rec.sourceKind !== 'string' ||
      !['upload_text', 'reference_ppt', 'wiki_kb'].includes(rec.sourceKind) ||
      typeof rec.locator !== 'string' ||
      !rec.locator.trim()
    )
      invalidInput(
        `${what}的来源引用格式不对：每项须为 {sourceId, sourceKind: upload_text|reference_ppt|wiki_kb, locator}`
      );
    out.push({
      sourceId: (rec.sourceId as string).trim(),
      sourceKind: rec.sourceKind as PageSourceRefInput['sourceKind'],
      locator: (rec.locator as string).trim(),
    });
  }
  return out;
}

/** 内容源出处归属校验：引用的来源须存在且属于调用方、类型须对上。 */
async function assertRefsOwned(
  refs: PageSourceRefInput[],
  owner: SourceOwner,
  what: string
): Promise<void> {
  const ids = [...new Set(refs.map((r) => r.sourceId))];
  let rows: Awaited<ReturnType<typeof getOwnedSources>>;
  try {
    rows = await getOwnedSources(ids, owner);
  } catch {
    invalidInput(`${what}引用的内容源不存在或不属于调用方`);
  }
  const byId = new Map(rows!.map((r) => [r.id, r]));
  for (const ref of refs) {
    const row = byId.get(ref.sourceId);
    if (!row)
      invalidInput(`${what}引用的内容源 ${ref.sourceId} 不存在或不属于调用方`);
    if (row.kind !== ref.sourceKind)
      invalidInput(
        `${what}引用的内容源 ${ref.sourceId} 类型是 ${row.kind}，不是 ${ref.sourceKind}`
      );
  }
}

/**
 * 解析图表的数据来源（三路之外不取数）：
 * - inline（默认）：categories + series 直接贴数。
 * - file：当次传的 csv / xlsx 文件，服务端解析第一张表。
 * - content_source：categories + series + pageSourceRefs（须归属调用方）。
 * 返回已校验的数据与出处（inline 时出处为空）。
 */
async function resolveChartData(
  raw: Record<string, unknown>,
  owner: SourceOwner
): Promise<{ data: ChartData; pageSourceRefs?: PageSourceRefInput[] }> {
  const kind =
    raw.sourceKind === 'file'
      ? 'file'
      : raw.sourceKind === 'content_source'
        ? 'content_source'
        : 'inline';
  if (kind === 'file') {
    const file = raw.file;
    if (typeof file !== 'object' || file === null || Array.isArray(file))
      invalidInput(
        'sourceKind=file 时须传 file（{name, mime, base64}，csv / xlsx）'
      );
    const f = file as Record<string, unknown>;
    if (
      typeof f.name !== 'string' ||
      typeof f.mime !== 'string' ||
      typeof f.base64 !== 'string'
    )
      invalidInput('file 须为 {name, mime, base64}');
    return {
      data: parseTableFile({
        name: f.name,
        mime: f.mime,
        base64: f.base64,
      }),
    };
  }
  const data = validateChartData({
    categories: raw.categories,
    series: raw.series,
  });
  if (kind === 'content_source') {
    const refs = asPageSourceRefs(raw.pageSourceRefs, '内容源数据');
    await assertRefsOwned(refs, owner, '内容源数据');
    return { data, pageSourceRefs: refs };
  }
  if (raw.pageSourceRefs !== undefined) {
    // inline 时附带出处也认（留痕用），但不强制。
    const refs = asPageSourceRefs(raw.pageSourceRefs, '图表数据');
    await assertRefsOwned(refs, owner, '图表数据');
    return { data, pageSourceRefs: refs };
  }
  return { data };
}

/** 解析一个图表输入（数据＋类型＋标签），软冲突未确认时返回拟确认清单。 */
async function normalizeChartSpec(
  raw: Record<string, unknown>,
  owner: SourceOwner,
  confirm: boolean
): Promise<{ spec: ChartSpec } | { proposal: ChartMismatchProposal }> {
  if (typeof raw.title === 'string' && raw.title.trim().length > 200)
    invalidInput('图表标题不超过 200 字');
  const valueLabels =
    typeof raw.valueLabels === 'string' &&
    (VALUE_LABELS as readonly string[]).includes(raw.valueLabels)
      ? (raw.valueLabels as ValueLabels)
      : raw.valueLabels === undefined
        ? 'show_all'
        : invalidInput(`value_labels 只接受 ${VALUE_LABELS.join('、')}`);
  const { data, pageSourceRefs } = await resolveChartData(raw, owner);
  let chartType: ChartType;
  let chartTypeAuto = false;
  if (raw.chartType === undefined) {
    const auto = autoChartType(data);
    chartType = auto.chartType;
    chartTypeAuto = true;
  } else if (
    typeof raw.chartType === 'string' &&
    (CHART_TYPES as readonly string[]).includes(raw.chartType)
  ) {
    chartType = raw.chartType as ChartType;
  } else {
    invalidInput(`chart_type 只接受 ${CHART_TYPES.join('、')}`);
  }
  const mismatch = checkTypeMismatch(chartType, data);
  if (mismatch && !confirm)
    return {
      proposal: {
        requiresConfirmation: true,
        requestedType: chartType,
        suggestedType: mismatch.suggestedType,
        reason: mismatch.reason,
      },
    };
  return {
    spec: {
      ...(typeof raw.title === 'string' && raw.title.trim()
        ? { title: raw.title.trim() }
        : {}),
      data,
      chartType,
      chartTypeAuto,
      valueLabels,
      ...(pageSourceRefs ? { pageSourceRefs } : {}),
    },
  };
}

/**
 * 解析一份图表落图明细（页 + 槽位/矩形 + 图表 + 可选数字卡）。
 * outlinePages 有值时（生成时）用它取版式；为 null 时（chart_add）
 * 版式取自任务行 layout_assignments（无版式记录时 slotId 不可用）。
 */
export async function normalizeChartAssignment(
  raw: unknown,
  job: Pick<PresentationJob, 'layoutAssignments'>,
  outlinePages: OutlinePage[] | null,
  owner: SourceOwner,
  confirm: boolean
): Promise<
  { assignment: ChartAssignment } | { proposal: ChartMismatchProposal }
> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    invalidInput('图表落图明细须为对象');
  const r = raw as Record<string, unknown>;
  const pageNo = r.pageNo;
  if (typeof pageNo !== 'number' || !Number.isInteger(pageNo) || pageNo < 1)
    invalidInput('图表目标页 pageNo 须为正整数');
  if (typeof r.chart !== 'object' || r.chart === null || Array.isArray(r.chart))
    invalidInput('图表落图明细须含 chart（数据 + 类型 + 标签）');
  const specResult = await normalizeChartSpec(
    r.chart as Record<string, unknown>,
    owner,
    confirm
  );
  if ('proposal' in specResult) return specResult;
  const spec = specResult.spec;
  const layoutCode =
    outlinePages?.find((p) => p.pageNo === pageNo)?.layout ??
    parseLayoutAssignments(job.layoutAssignments)?.find(
      (l) => l.pageNo === pageNo
    )?.layout ??
    null;
  // Dashboard：有数字卡时版式走 A（数据条加四卡）或 G / H 的分栏结构。
  if (Array.isArray(r.kpiCards) && r.kpiCards.length > 0) {
    if (
      layoutCode &&
      layoutCode !== 'A' &&
      layoutCode !== 'G' &&
      layoutCode !== 'H'
    )
      invalidInput(
        `Dashboard 页（带数字卡）版式须为 A、G 或 H，当前第 ${pageNo} 页是 ${layoutCode}：请先在 outline 里把该页版式改成 A、G 或 H`
      );
  }
  const rectIn =
    typeof r.slotId === 'string' && r.slotId.trim()
      ? resolveChartRect(job, pageNo, layoutCode, { slotId: r.slotId.trim() })
      : r.rectIn !== undefined
        ? validateRectIn(r.rectIn, '图表位置')
        : invalidInput(
            '图表须指定 slotId（版式槽位）或 rectIn（明确矩形，英寸）'
          );
  let kpiCards: KpiCard[] | undefined;
  if (Array.isArray(r.kpiCards) && r.kpiCards.length > 0) {
    // 数字卡先按数据口径校验（卡图同源），再解析落位。
    for (const card of r.kpiCards as unknown[]) {
      if (typeof card !== 'object' || card === null || Array.isArray(card))
        invalidInput('每张数字卡须为对象');
      const refs = (card as Record<string, unknown>).pageSourceRefs;
      if (Array.isArray(refs) && refs.length > 0) {
        const parsed = asPageSourceRefs(refs, '数字卡');
        await assertRefsOwned(parsed, owner, '数字卡');
      }
    }
    validateKpiCards(r.kpiCards, spec.data);
    const autoSlots =
      layoutCode === 'A'
        ? allSlots('A')
            .filter((s) => s.type === 'kpi_card')
            .map((s) => s.id)
        : [];
    let autoIdx = 0;
    kpiCards = [];
    for (const card of r.kpiCards as unknown[]) {
      const c = card as Record<string, unknown>;
      let cardRect: RectIn;
      if (typeof c.slotId === 'string' && c.slotId.trim()) {
        cardRect = resolveChartRect(job, pageNo, layoutCode, {
          slotId: c.slotId.trim(),
        });
      } else if (c.rectIn !== undefined) {
        cardRect = validateRectIn(c.rectIn, '数字卡位置');
      } else if (autoIdx < autoSlots.length) {
        cardRect = resolveChartRect(job, pageNo, layoutCode, {
          slotId: autoSlots[autoIdx],
        });
        autoIdx += 1;
      } else {
        invalidInput(
          '数字卡须指定 slotId 或 rectIn（A 版式前 3 张卡可用默认数字卡槽位）'
        );
      }
      kpiCards.push({
        title: String(c.title).trim(),
        value: c.value as number,
        ...(typeof c.unit === 'string' && c.unit ? { unit: c.unit } : {}),
        ...(typeof c.fromData === 'object' && c.fromData !== null
          ? {
              fromData: c.fromData as KpiCard['fromData'],
            }
          : {}),
        ...(Array.isArray(c.pageSourceRefs) && c.pageSourceRefs.length > 0
          ? {
              pageSourceRefs: asPageSourceRefs(c.pageSourceRefs, '数字卡'),
            }
          : {}),
        rectIn: cardRect,
      });
    }
  }
  return {
    assignment: {
      pageNo,
      rectIn,
      chart: spec,
      ...(kpiCards ? { kpiCards } : {}),
    },
  };
}

/** 图表/数字卡的落位矩形：slotId 查版式注册表，rectIn 直接校验。 */
function resolveChartRect(
  job: Pick<PresentationJob, 'layoutAssignments'>,
  pageNo: number,
  layoutCode: LayoutCode | null,
  raw: { slotId?: string }
): RectIn {
  if (raw.slotId) {
    if (!layoutCode)
      invalidInput(
        `第 ${pageNo} 页没有版式记录，无法按槽位 ${raw.slotId} 定位：请给明确矩形 rectIn`
      );
    const slot = findSlot(layoutCode, raw.slotId);
    if (!slot)
      invalidInput(
        `第 ${pageNo} 页的版式 ${layoutCode} 没有槽位 ${raw.slotId}`
      );
    return { ...slot.rectIn };
  }
  invalidInput('须给出 slotId（版式槽位）或 rectIn（明确矩形，英寸）');
}

/**
 * 生成时登记的图表落图：成稿一出即执行（refreshJob / runSmartStream
 * 在 completeJob 后调用）。每页落图存一个版本（ops 记 chart_add），
 * 下载随之指向落图后的版本。任一页落图失败即抛错，调用方置任务 failed。
 */
export async function applyGenerateCharts(job: PresentationJob): Promise<void> {
  const assignments = parseChartAssignments(job.chartAssignments);
  if (!assignments || assignments.length === 0) return;
  const fresh = await getJob(job.id);
  const target = fresh ?? job;
  if (target.status !== 'completed' || !target.exportPath) return;
  let bytes = await downloadOriginalPptx(target);
  let version = await getCurrentPageVersion(target.id);
  for (const a of [...assignments].sort((x, y) => x.pageNo - y.pageNo)) {
    if (target.slideCount !== null && a.pageNo > target.slideCount)
      throw new PresentonError(
        'invalid_input',
        `图表目标页 ${a.pageNo} 超出成稿页数 ${target.slideCount}：图表未落入`
      );
    let out = bytes;
    let kpiElementIds: string[] = [];
    if (a.kpiCards && a.kpiCards.length > 0) {
      const r = insertKpiCards(out, a.pageNo, a.kpiCards);
      out = r.bytes;
      kpiElementIds = r.elementIds;
    }
    const ins = insertChart(out, a.pageNo, a.rectIn, a.chart);
    out = ins.bytes;
    version += 1;
    await createPageVersion({
      jobId: target.id,
      version,
      pageNo: a.pageNo,
      ops: [
        {
          op: 'chart_add',
          pageNo: a.pageNo,
          chartElementId: ins.elementId,
          chartType: a.chart.chartType,
          chartTypeAuto: a.chart.chartTypeAuto,
          valueLabels: a.chart.valueLabels,
          ...(kpiElementIds.length > 0
            ? {
                kpiCards: a.kpiCards!.length,
                kpiCardElementIds: kpiElementIds,
              }
            : {}),
        },
      ],
      bytes: out,
    });
    bytes = out;
  }
  const index = buildElementIndex(bytes);
  if (index)
    await updateJob(target.id, {
      elementIndex: serializeJobMeta(index),
    }).catch(() => {});
}

function chartPagePreview(bytes: Buffer, pageNo: number, job: PresentationJob) {
  const layoutCode = jobLayoutCode(job, pageNo);
  const preview = getPageElements(bytes, pageNo, layoutCode);
  return {
    rendered: false,
    note: '服务端容器内无 LibreOffice 等渲染工具，单页预览为改后元素清单（含图表元素，非图片）；请在 PowerPoint 中打开下载文件核对',
    elements: preview.elements,
  };
}

export type ChartAddResult =
  | {
      requiresConfirmation: true;
      requestedType: ChartType;
      suggestedType: ChartType;
      reason: string;
    }
  | {
      requiresConfirmation?: false;
      jobId: string;
      pageNo: number;
      version: number;
      chartElementId: string;
      chartType: ChartType;
      chartTypeAuto: boolean;
      valueLabels: ValueLabels;
      kpiCardElementIds: string[];
      chartSummary: ReturnType<typeof chartSummary>;
      pagePreview: ReturnType<typeof chartPagePreview>;
    };

/**
 * presentations_chart_add：在已完成稿子的指定页插入一个原生图表
 * （+ 可选 Dashboard 数字卡）。软冲突未确认时返回拟确认清单，
 * 不写文件；确认后（confirm=true）执行并存新版本。
 */
export async function addChartToJob(
  job: PresentationJob,
  pageNo: number,
  raw: unknown,
  viewer: ImageViewer,
  opts?: { confirm?: boolean }
): Promise<ChartAddResult> {
  if (!Number.isInteger(pageNo) || pageNo < 1)
    invalidInput('pageNo 须为正整数');
  if (job.slideCount !== null && pageNo > job.slideCount)
    invalidInput(`第 ${pageNo} 页不存在（本稿共 ${job.slideCount} 页）`);
  const owner: SourceOwner = {
    userId: viewer.userId,
    tokenId: viewer.tokenId ?? null,
  };
  const normalized = await normalizeChartAssignment(
    raw,
    job,
    null,
    owner,
    opts?.confirm === true
  );
  if ('proposal' in normalized) return normalized.proposal;
  const assignment = normalized.assignment;
  const bytes = await getJobCurrentBytes(job);
  let out = bytes;
  let kpiElementIds: string[] = [];
  if (assignment.kpiCards && assignment.kpiCards.length > 0) {
    const r = insertKpiCards(out, pageNo, assignment.kpiCards);
    out = r.bytes;
    kpiElementIds = r.elementIds;
  }
  const ins = insertChart(out, pageNo, assignment.rectIn, assignment.chart);
  const currentVersion = await getCurrentPageVersion(job.id);
  const version = currentVersion + 1;
  await createPageVersion({
    jobId: job.id,
    version,
    pageNo,
    ops: [
      {
        op: 'chart_add',
        pageNo,
        chartElementId: ins.elementId,
        chartType: assignment.chart.chartType,
        chartTypeAuto: assignment.chart.chartTypeAuto,
        valueLabels: assignment.chart.valueLabels,
        ...(kpiElementIds.length > 0
          ? {
              kpiCards: assignment.kpiCards!.length,
              kpiCardElementIds: kpiElementIds,
            }
          : {}),
      },
    ],
    bytes: ins.bytes,
  });
  const index = buildElementIndex(ins.bytes);
  if (index)
    await updateJob(job.id, {
      elementIndex: serializeJobMeta(index),
    }).catch(() => {});
  return {
    jobId: job.id,
    pageNo,
    version,
    chartElementId: ins.elementId,
    chartType: assignment.chart.chartType,
    chartTypeAuto: assignment.chart.chartTypeAuto,
    valueLabels: assignment.chart.valueLabels,
    kpiCardElementIds: kpiElementIds,
    chartSummary: chartSummary(assignment.chart),
    pagePreview: chartPagePreview(ins.bytes, pageNo, job),
  };
}

export type ChartUpdateResult =
  | {
      requiresConfirmation: true;
      requestedType: ChartType;
      suggestedType: ChartType;
      reason: string;
    }
  | {
      requiresConfirmation?: false;
      jobId: string;
      pageNo: number;
      version: number;
      chartElementId: string;
      chartType: ChartType;
      valueLabels: ValueLabels;
      pagePreview: ReturnType<typeof chartPagePreview>;
    };

/**
 * presentations_chart_update：改已有图表（换数据、换类型、切数值标签
 * 显隐）。只动该图表所在页：只改 chart 部件（+ 换数据时内嵌工作簿），
 * slide XML 不动，其余页逐字节保留。类型软冲突未确认时先返回拟确认
 * 清单；标签切换只改标签层，数据与坐标轴不变。
 */
export async function updateChartOnJob(
  job: PresentationJob,
  pageNo: number,
  elementId: string,
  raw: unknown,
  viewer: ImageViewer,
  opts?: { confirm?: boolean }
): Promise<ChartUpdateResult> {
  if (!Number.isInteger(pageNo) || pageNo < 1)
    invalidInput('pageNo 须为正整数');
  if (job.slideCount !== null && pageNo > job.slideCount)
    invalidInput(`第 ${pageNo} 页不存在（本稿共 ${job.slideCount} 页）`);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    invalidInput('图表更新内容须为对象');
  const r = raw as Record<string, unknown>;
  const owner: SourceOwner = {
    userId: viewer.userId,
    tokenId: viewer.tokenId ?? null,
  };
  const bytes = await getJobCurrentBytes(job);
  const current = readChartInfo(bytes, pageNo, elementId);
  // 换数据：走与 chart_add 同样的三路来源校验。
  let newData: ChartData | undefined;
  const hasDataInput =
    r.data !== undefined || r.file !== undefined || r.sourceKind !== undefined;
  if (hasDataInput) {
    const resolved = await resolveChartData(
      {
        categories: (r.data as Record<string, unknown> | undefined)?.categories,
        series: (r.data as Record<string, unknown> | undefined)?.series,
        sourceKind: r.sourceKind,
        pageSourceRefs: r.pageSourceRefs,
        file: r.file,
      },
      owner
    );
    newData = resolved.data;
  }
  let newType = current.chartType;
  if (r.chartType !== undefined) {
    if (
      typeof r.chartType !== 'string' ||
      !(CHART_TYPES as readonly string[]).includes(r.chartType)
    )
      invalidInput(`chart_type 只接受 ${CHART_TYPES.join('、')}`);
    newType = r.chartType as ChartType;
  }
  let newLabels = current.valueLabels;
  if (r.valueLabels !== undefined) {
    if (
      typeof r.valueLabels !== 'string' ||
      !(VALUE_LABELS as readonly string[]).includes(r.valueLabels)
    )
      invalidInput(`value_labels 只接受 ${VALUE_LABELS.join('、')}`);
    newLabels = r.valueLabels as ValueLabels;
  }
  if (hasDataInput || r.chartType !== undefined) {
    const mismatch = checkTypeMismatch(newType, newData ?? current.data);
    if (mismatch && opts?.confirm !== true)
      return {
        requiresConfirmation: true,
        requestedType: newType,
        suggestedType: mismatch.suggestedType,
        reason: mismatch.reason,
      };
  }
  const updated = updateChart(bytes, pageNo, elementId, {
    ...(newData ? { data: newData } : {}),
    ...(r.chartType !== undefined ? { chartType: newType } : {}),
    ...(r.valueLabels !== undefined ? { valueLabels: newLabels } : {}),
    ...(typeof r.title === 'string' ? { title: r.title } : {}),
  });
  const currentVersion = await getCurrentPageVersion(job.id);
  const version = currentVersion + 1;
  await createPageVersion({
    jobId: job.id,
    version,
    pageNo,
    ops: [
      {
        op: 'chart_update',
        pageNo,
        chartElementId: elementId,
        ...(newData ? { dataChanged: true } : {}),
        ...(r.chartType !== undefined ? { chartType: newType } : {}),
        ...(r.valueLabels !== undefined ? { valueLabels: newLabels } : {}),
        ...(typeof r.title === 'string' ? { title: r.title } : {}),
      },
    ],
    bytes: updated.bytes,
  });
  const index = buildElementIndex(updated.bytes);
  if (index)
    await updateJob(job.id, {
      elementIndex: serializeJobMeta(index),
    }).catch(() => {});
  return {
    jobId: job.id,
    pageNo,
    version,
    chartElementId: elementId,
    chartType: updated.chartType,
    valueLabels: updated.valueLabels,
    pagePreview: chartPagePreview(updated.bytes, pageNo, job),
  };
}
