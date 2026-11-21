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
