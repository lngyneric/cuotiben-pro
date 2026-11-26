// PPT 生成共享逻辑：助手页对话框与独立 PPT 页（/ai-assistant/ppt）共用。
// 只读本机浏览器 localStorage 与纯函数，不读数据库、不调接口。

/** PPT 生成任务状态（与服务端 /api/ai-assistant/presentations 的 GET 回包一致）。 */
export interface PptJobStatus {
  jobId: string;
  status: 'queued' | 'generating' | 'completed' | 'failed';
  title?: string | null;
  slideCount?: number | null;
  downloadUrl?: string;
  error?: string;
  errorCode?: string;
}

/** 已完成的 PPT 任务（只存本机浏览器，刷新后下载链接还在）。 */
export interface PptJobRecord {
  jobId: string;
  title?: string | null;
  slideCount?: number | null;
  downloadUrl: string;
  completedAt: number;
}

/** 对话历史只存本机浏览器（刷新不丢；换设备不带走）。 */
export const CHAT_STORAGE_KEY = 'ai-assistant-chat-v1';
/** 参考资料文本与文件名（与对话分开的 key；抽出的长文本只存这里）。 */
export const ATTACH_STORAGE_KEY = 'ai-assistant-attachments-v1';
/** 已完成的 PPT 任务（只存本机浏览器；刷新后下载链接还在）。 */
export const PPT_JOBS_STORAGE_KEY = 'ai-assistant-ppt-jobs-v1';
export const MAX_STORED_PPT_JOBS = 5;

export function loadStoredPptJobs(): PptJobRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PPT_JOBS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (j): j is PptJobRecord =>
          !!j &&
          typeof j.jobId === 'string' &&
          typeof j.downloadUrl === 'string'
      )
      .slice(0, MAX_STORED_PPT_JOBS);
  } catch {
    return [];
  }
}

/** 把一个已完成的任务记到本机列表最前面（去重，最多 5 条），返回新列表。 */
export function storePptJob(job: PptJobRecord): PptJobRecord[] {
  const next = [
    job,
    ...loadStoredPptJobs().filter((j) => j.jobId !== job.jobId),
  ].slice(0, MAX_STORED_PPT_JOBS);
  try {
    window.localStorage.setItem(PPT_JOBS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 存储满或被禁时静默跳过，不影响下载。
  }
  return next;
}

/** PPT 对话框默认内容：最近一轮提问 + 最新回答 + 参考资料文本。 */
export function buildPptContent(
  lastUser: string | undefined,
  lastAssistant: string | undefined,
  attachmentContext: string
): string {
  const parts: string[] = [];
  if (lastUser) parts.push(`问题：${lastUser}`);
  if (lastAssistant) parts.push(`回答：${lastAssistant}`);
  if (attachmentContext) parts.push(`参考资料：\n${attachmentContext}`);
  return parts.join('\n\n').slice(0, 100_000);
}

function loadStoredChatTexts(): {
  lastUser?: string;
  lastAssistant?: string;
} {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};
    const texts = parsed.filter(
      (m): m is { role: string; text: string } =>
        !!m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.text === 'string'
    );
    const lastUser = [...texts].reverse().find((m) => m.role === 'user')?.text;
    const lastAssistant = [...texts]
      .reverse()
      .find((m) => m.role === 'assistant')?.text;
    return { lastUser, lastAssistant };
  } catch {
    return {};
  }
}

function loadStoredAttachmentContext(): string {
  if (typeof window === 'undefined') return '';
  try {
    const raw = window.localStorage.getItem(ATTACH_STORAGE_KEY);
    if (!raw) return '';
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return typeof parsed.context === 'string' ? parsed.context : '';
    }
    // 兼容旧格式：整个值就是参考资料文本。
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return '';
  }
}

/** 独立 PPT 页用：从本机保存的对话与参考资料拼出默认内容。 */
export function loadStoredPptContent(): string {
  const { lastUser, lastAssistant } = loadStoredChatTexts();
  return buildPptContent(
    lastUser,
    lastAssistant,
    loadStoredAttachmentContext()
  );
}

// ─── 意图抽取（导航＋意图优化，第二批）───────────────────────────────────
// 从用户一句话里抽：要几页、要不要标题页。抽不到的字段不填，由页签
// 的 outline 草稿面板问一句再生成，绝不猜。规则按“显式计数优先”：
// “页数填 3”＞“做 3 页”＞“共 3 页”＞“第 1/2/3 页”取最大页码＞
// “一页/单页”＞裸“3 页”。注意内容里常有 AI 助手给的三页计划
// （“第 1 页封面……第 2 页……第 3 页……”），裸数字正则会先撞上
// “第 1 页”误判 1 页，所以“第 N 页”必须按最大页码取，不取首个。

export interface PptIntent {
  nSlides?: number;
  titlePage?: boolean;
}

export function parsePptIntent(text: string): PptIntent {
  const intent: PptIntent = {};
  const t = (text || '').replace(/\s+/g, '');
  if (!t) return intent;
  const clamp = (n: number) => Math.min(50, Math.max(1, n));
  const explicit = t.match(/页数\D{0,4}(\d{1,2})/);
  const verb = t.match(/(?:做|生成|出|要|给|来)(\d{1,2})页/);
  const total = t.match(/共(\d{1,2})页/);
  const markers = [...t.matchAll(/第(\d{1,2})页/g)].map((m) =>
    Number(m[1])
  );
  const bare = t.match(/(\d{1,2})页/);
  if (explicit) intent.nSlides = clamp(Number(explicit[1]));
  else if (verb) intent.nSlides = clamp(Number(verb[1]));
  else if (total) intent.nSlides = clamp(Number(total[1]));
  else if (markers.length > 0) intent.nSlides = clamp(Math.max(...markers));
  else if (/一页|单页|只有一页|就一页|一页纸/.test(t)) intent.nSlides = 1;
  else if (bare) intent.nSlides = clamp(Number(bare[1]));
  // 标题页：否定说法优先——“不要做封面”里同时含“做封面”，必须先判否定。
  if (
    /不要标题页|去掉标题页|不用标题页|不要封面|去掉封面|不用封面|无标题页|没有标题页|不做封面|不要做封面/.test(
      t
    )
  )
    intent.titlePage = false;
  else if (
    /要标题页|保留标题页|加标题页|需要标题页|带封面|要有封面|需要封面|做封面|加个封面/.test(
      t
    )
  )
    intent.titlePage = true;
  return intent;
}

// ─── 习惯记忆（导航＋意图优化，第二批）───────────────────────────────────
// 用户的选择（页数、标题页、模式、模板）记在本机 localStorage（与聊天
// 记录同路）：下次生成默认按习惯走，随时可改。没有 wiki 已有的人均偏好
// 位置（config 表是全局管理员配置，不是人均偏好），所以不用服务端存；
// 换设备不同步——与聊天记录同一口径。

export interface PptPrefs {
  nSlides?: number;
  titlePage?: boolean;
  mode?: 'standard' | 'smart';
  template?: string;
}

export const PPT_PREFS_STORAGE_KEY = 'ai-assistant-ppt-prefs-v1';

export function loadPptPrefs(): PptPrefs {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PPT_PREFS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const prefs: PptPrefs = {};
    if (
      typeof parsed.nSlides === 'number' &&
      Number.isInteger(parsed.nSlides) &&
      parsed.nSlides >= 1 &&
      parsed.nSlides <= 50
    )
      prefs.nSlides = parsed.nSlides;
    if (typeof parsed.titlePage === 'boolean')
      prefs.titlePage = parsed.titlePage;
    if (parsed.mode === 'standard' || parsed.mode === 'smart')
      prefs.mode = parsed.mode;
    if (typeof parsed.template === 'string' && parsed.template)
      prefs.template = parsed.template;
    return prefs;
  } catch {
    return {};
  }
}

export function savePptPrefs(prefs: PptPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      PPT_PREFS_STORAGE_KEY,
      JSON.stringify(prefs)
    );
  } catch {
    // 存储满或被禁时静默跳过，不影响生成。
  }
}

// ─── 进行中的任务（导航＋意图优化：页签切换后轮询按 jobId 恢复）───────
// 只记当前在跑的任务 id；完成/失败后由调用方清除。刷新页面或切换页签
// 后，PPT 页签按这个 id 恢复轮询，不重跑生成。

export const PPT_CURRENT_JOB_STORAGE_KEY =
  'ai-assistant-ppt-current-job-v1';

export function loadStoredCurrentPptJob(): { jobId: string } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PPT_CURRENT_JOB_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.jobId === 'string' && parsed.jobId)
      return { jobId: parsed.jobId };
    return null;
  } catch {
    return null;
  }
}

export function storeCurrentPptJob(jobId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (jobId)
      window.localStorage.setItem(
        PPT_CURRENT_JOB_STORAGE_KEY,
        JSON.stringify({ jobId })
      );
    else window.localStorage.removeItem(PPT_CURRENT_JOB_STORAGE_KEY);
  } catch {
    // 存储满或被禁时静默跳过，不影响生成。
  }
}

// ─── 对话框 → PPT 页签的交接草稿 ─────────────────────────────────────────
// 对话页 PPT 对话框提交后不再直接生成：把表单值存这里，跳到 PPT 页签，
// 页签读取后走 outline 草稿 → 确认 → 生成。读后由页签清除，避免下次
// 进页签时被旧草稿顶掉。

export interface PptDraft {
  content: string;
  nSlides?: string;
  mode?: 'standard' | 'smart';
  template?: string;
  titlePage?: boolean;
  instructions?: string;
}

export const PPT_DRAFT_STORAGE_KEY = 'ai-assistant-ppt-draft-v1';

export function savePptDraft(draft: PptDraft): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PPT_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // 存储满或被禁时静默跳过，页签仍可用对话历史兜底。
  }
}

export function loadPptDraft(): PptDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PPT_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.content !== 'string') return null;
    return parsed as PptDraft;
  } catch {
    return null;
  }
}

export function clearPptDraft(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(PPT_DRAFT_STORAGE_KEY);
  } catch {
    // 删不掉也不影响，页签只读一次。
  }
}

// ─── outline 草稿页（客户端侧，与服务端 OutlinePage 同形）──────────────

export interface OutlinePageDraft {
  pageNo: number;
  title: string;
  points: string[];
  layout: string;
  layoutReason: string;
  sources: Array<{
    sourceId: string;
    sourceKind: string;
    locator: string;
  }>;
  primaryKind: string;
  insufficient?: boolean;
  note?: string;
}

/** 用户只要 1 页、草稿却划出多页时：把全部要点并进第 1 页，确认用。 */
export function mergeOutlinePagesToOne(
  pages: OutlinePageDraft[]
): OutlinePageDraft[] {
  if (pages.length <= 1) return pages;
  const first = pages[0];
  return [
    {
      ...first,
      pageNo: 1,
      points: pages.flatMap((p) => p.points),
      sources: pages.flatMap((p) => p.sources ?? []),
      note: `由 ${pages.length} 页合并`,
    },
  ];
}
