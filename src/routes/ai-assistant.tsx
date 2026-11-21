import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

import { useSession } from '@/core/auth/client';
import { Link } from '@/core/i18n/navigation';
import { localizedAbsoluteUrl } from '@/core/i18n/urls';
import { envConfigs } from '@/config';
import { apiGet, apiPost } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';
import { getLocale, locales } from '@/paraglide/runtime.js';
import { useUserPermissions } from '@/hooks/use-user-permissions';
import { Footer } from '@/blocks/footer';
import { Header } from '@/blocks/header';
import { buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

interface RecommendedCourse {
  slug: string;
  title: string;
  description: string;
  categories: string[];
  type: 'video' | 'text';
  link: string;
}

interface DocSource {
  docTitle: string;
  sectionTitle: string;
  url: string;
}

interface ChatResult {
  answer: string;
  courses: RecommendedCourse[];
  sources: DocSource[];
  mode: 'chat' | 'keyword' | 'doc';
  found: boolean;
  /** 服务端回传的本轮生效参考资料文本（下轮带回）。 */
  attachmentContext?: string;
}

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  courses?: RecommendedCourse[];
  sources?: DocSource[];
  /** 用户消息随附的附件名（只存名，不存抽出的文本）。 */
  attachments?: string[];
}

/** PPT 生成任务状态（与服务端 /api/ai-assistant/presentations 的 GET 回包一致）。 */
interface PptJobStatus {
  jobId: string;
  status: 'queued' | 'generating' | 'completed' | 'failed';
  title?: string | null;
  slideCount?: number | null;
  downloadUrl?: string;
  error?: string;
  errorCode?: string;
}

/** 待发送的附件（base64 已备好，随下一轮提问一起发）。 */
interface PendingAttachment {
  id: number;
  name: string;
  mime: string;
  base64: string;
  size: number;
  isImage: boolean;
}

/** 与服务端 allowlist 一致（扩展名 + MIME 双重校验在服务端做）。 */
const ATTACH_ACCEPT =
  '.txt,.md,.csv,.tsv,.docx,.pdf,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.webp';
const MAX_PENDING_FILES = 5;
const MAX_PENDING_IMAGES = 3;
const MAX_IMAGE_SIDE = 1568;

const TOPIC_KEYS = [
  'ai_assistant.topic_leadership',
  'ai_assistant.topic_lab',
  'ai_assistant.topic_sales',
  'ai_assistant.topic_newcomer',
] as const;

/** 对话历史只存本机浏览器（刷新不丢；换设备不带走）。 */
const CHAT_STORAGE_KEY = 'ai-assistant-chat-v1';
/** 参考资料文本与文件名（与对话分开的 key；抽出的长文本只存这里）。 */
const ATTACH_STORAGE_KEY = 'ai-assistant-attachments-v1';
/** 已完成的 PPT 任务（只存本机浏览器；刷新后下载链接还在）。 */
const PPT_JOBS_STORAGE_KEY = 'ai-assistant-ppt-jobs-v1';
const MAX_STORED_PPT_JOBS = 5;

interface PptJobRecord {
  jobId: string;
  title?: string | null;
  slideCount?: number | null;
  downloadUrl: string;
  completedAt: number;
}

function loadStoredPptJobs(): PptJobRecord[] {
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
function storePptJob(job: PptJobRecord): PptJobRecord[] {
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

function loadStoredAttachments(): { context: string; fileNames: string[] } {
  if (typeof window === 'undefined') return { context: '', fileNames: [] };
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(ATTACH_STORAGE_KEY) ?? ''
    );
    return {
      context: typeof parsed?.context === 'string' ? parsed.context : '',
      fileNames: Array.isArray(parsed?.fileNames)
        ? parsed.fileNames.filter((n): n is string => typeof n === 'string')
        : [],
    };
  } catch {
    return { context: '', fileNames: [] };
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileToDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

function base64Of(dataUrl: string): string {
  const i = dataUrl.indexOf(',');
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

/**
 * 图片预处理：最长边超过 1568px 时用 canvas 缩放后转 JPEG（0.9），
 * 小图原样返回（不重新编码）。返回待发送的附件。
 */
async function processImageFile(
  file: File,
  id: number
): Promise<PendingAttachment> {
  const dataUrl = await fileToDataUrl(file);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('image load failed'));
    img.src = dataUrl;
  });
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  if (longest <= MAX_IMAGE_SIDE) {
    return {
      id,
      name: file.name,
      mime: file.type || 'image/png',
      base64: base64Of(dataUrl),
      size: file.size,
      isImage: true,
    };
  }
  const scale = MAX_IMAGE_SIDE / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.9)
  );
  if (!blob) throw new Error('canvas encode failed');
  const resizedUrl = await fileToDataUrl(blob);
  const base = file.name.replace(/\.[^.]*$/, '') || 'screenshot';
  return {
    id,
    name: `${base}.jpg`,
    mime: 'image/jpeg',
    base64: base64Of(resizedUrl),
    size: blob.size,
    isImage: true,
  };
}

function loadStoredMessages(): ChatMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is ChatMessage =>
          !!m &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.text === 'string'
      )
      .slice(-30);
  } catch {
    return [];
  }
}

export const Route = createFileRoute('/ai-assistant')({
  loader: async () => {
    const locale = getLocale();
    return { locale };
  },
  head: ({ loaderData }) => {
    const locale = loaderData?.locale ?? 'zh';
    const urlFor = (loc: string) => localizedAbsoluteUrl('/ai-assistant', loc);
    return {
      meta: [
        {
          title: `${m['ai_assistant.title']({}, { locale: locale as any })} | ${envConfigs.app_name}`,
        },
        {
          name: 'description',
          content: m['ai_assistant.description']({}, { locale: locale as any }),
        },
      ],
      links: [
        { rel: 'canonical', href: urlFor(locale) },
        ...locales.map((loc) => ({
          rel: 'alternate',
          hrefLang: loc,
          href: urlFor(loc),
        })),
      ],
    };
  },
  component: AiAssistantPage,
});

function CourseCard({ course }: { course: RecommendedCourse }) {
  return (
    <article className="border-border bg-card rounded-2xl border p-6">
      <span className="text-primary text-xs font-medium">
        {course.type === 'video'
          ? m['ai_assistant.video']()
          : m['ai_assistant.text']()}
      </span>
      <h2 className="mt-2 text-lg font-medium">{course.title}</h2>
      {course.description && (
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          {course.description}
        </p>
      )}
      <a
        href={course.link}
        target="_blank"
        rel="noreferrer"
        className="text-primary mt-4 inline-flex items-center gap-1.5 text-sm font-medium"
      >
        {m['ai_assistant.open_course']()} ↗
      </a>
    </article>
  );
}

function SourceCard({ source }: { source: DocSource }) {
  return (
    <a
      key={source.url}
      href={source.url}
      target="_blank"
      rel="noreferrer"
      className="border-border flex items-center justify-between gap-2 rounded-xl border px-4 py-3 text-sm"
    >
      <span>
        <span className="text-muted-foreground block text-xs">
          {m['ai_assistant.doc_source']()}
        </span>
        <span className="font-medium">
          {source.docTitle} · {source.sectionTitle}
        </span>
      </span>
      <span className="text-primary shrink-0 font-medium">
        {m['ai_assistant.open_doc']()} ↗
      </span>
    </a>
  );
}

function AiAssistantPage() {
  const { data: session, isPending: sessionPending } = useSession();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const idRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 附件：待发送的文件 + 已生效的参考资料（服务端抽取后回传）。
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState('');
  const [attachmentContext, setAttachmentContext] = useState('');
  const [refFileNames, setRefFileNames] = useState<string[]>([]);
  // 发送时随附件一起记下文件名，成功后更新“参考资料”提示。
  const sentNamesRef = useRef<string[]>([]);

  // 生成 PPT：只对有 admin.presentations.generate 权限的角色显示入口
  // （服务端接口仍各自鉴权，这里只决定“显不显示”）。
  const { data: userPermissions } = useUserPermissions();
  const canGeneratePpt =
    userPermissions?.permissions?.includes('admin.presentations.generate') ??
    false;
  const [pptDialogOpen, setPptDialogOpen] = useState(false);
  const [pptContent, setPptContent] = useState('');
  const [pptSlides, setPptSlides] = useState('6');
  const [pptMode, setPptMode] = useState<'standard' | 'smart'>('standard');
  const [pptInstructions, setPptInstructions] = useState('');
  const [pptJob, setPptJob] = useState<PptJobStatus | null>(null);
  const [pptPolling, setPptPolling] = useState(false);
  const [pptError, setPptError] = useState('');
  /** 本机已完成的 PPT 任务（刷新后下载链接还在）。 */
  const [pptJobs, setPptJobs] = useState<PptJobRecord[]>([]);

  /** 对话框默认内容：最近一轮提问 + 最新回答 + 参考资料文本。 */
  const assemblePptContent = () => {
    const parts: string[] = [];
    const lastUser = [...messages].reverse().find((msg) => msg.role === 'user');
    const lastAssistant = [...messages]
      .reverse()
      .find((msg) => msg.role === 'assistant');
    if (lastUser) parts.push(`问题：${lastUser.text}`);
    if (lastAssistant) parts.push(`回答：${lastAssistant.text}`);
    if (attachmentContext) parts.push(`参考资料：\n${attachmentContext}`);
    return parts.join('\n\n').slice(0, 100_000);
  };

  const openPptDialog = () => {
    setPptContent(assemblePptContent());
    setPptError('');
    setPptDialogOpen(true);
  };

  const pptMutation = useMutation({
    mutationFn: (vars: {
      content: string;
      nSlides: number;
      mode: 'standard' | 'smart';
      instructions?: string;
    }) =>
      apiPost<{ jobId: string; status: string }>(
        '/api/ai-assistant/presentations',
        vars
      ),
    onSuccess: (data) => {
      setPptJob({
        jobId: data.jobId,
        status: data.status as PptJobStatus['status'],
      });
      setPptPolling(true);
      setPptDialogOpen(false);
    },
    onError: (e) => {
      setPptError(e instanceof Error ? e.message : m['ai_assistant.error']());
    },
  });

  // 任务生成中时每 5 秒轮询一次状态，到终态（completed/failed）即停。
  useEffect(() => {
    if (!pptPolling || !pptJob) return;
    const timer = window.setInterval(() => {
      void apiGet<PptJobStatus>(
        `/api/ai-assistant/presentations?id=${encodeURIComponent(pptJob.jobId)}`
      )
        .then((data) => {
          setPptJob(data);
          if (data.status === 'completed' || data.status === 'failed')
            setPptPolling(false);
          if (data.status === 'completed' && data.downloadUrl) {
            setPptJobs(
              storePptJob({
                jobId: data.jobId,
                title: data.title,
                slideCount: data.slideCount,
                downloadUrl: data.downloadUrl,
                completedAt: Date.now(),
              })
            );
          }
        })
        .catch((e) => {
          // 轮询失败时停掉轮询并报错，避免无声卡住；任务本身还在服务端跑。
          setPptPolling(false);
          setPptError(
            e instanceof Error ? e.message : m['ai_assistant.error']()
          );
        });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pptPolling, pptJob?.jobId]);

  // 刷新后恢复本机保存的对话（只在客户端跑，避免服务端渲染不一致）。
  useEffect(() => {
    const stored = loadStoredMessages();
    if (stored.length > 0) {
      idRef.current = stored.reduce((max, m) => Math.max(max, m.id || 0), 0);
      setMessages(stored);
    }
    const storedAttach = loadStoredAttachments();
    setAttachmentContext(storedAttach.context);
    setRefFileNames(storedAttach.fileNames);
    setPptJobs(loadStoredPptJobs());
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        CHAT_STORAGE_KEY,
        JSON.stringify(messages.slice(-30))
      );
    } catch {
      // 存储满或被禁时静默跳过，不影响对话。
    }
  }, [messages]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        ATTACH_STORAGE_KEY,
        JSON.stringify({ context: attachmentContext, fileNames: refFileNames })
      );
    } catch {
      // 存储满或被禁时静默跳过，不影响对话。
    }
  }, [attachmentContext, refFileNames]);

  const mutation = useMutation({
    mutationFn: (vars: {
      query: string;
      history: { role: 'user' | 'assistant'; content: string }[];
      attachments?: { name: string; mime: string; base64: string }[];
      attachmentContext?: string;
    }) => apiPost<ChatResult>('/api/ai-assistant/chat', vars),
    onSuccess: (data) => {
      setMessages((prev) => [
        ...prev,
        {
          id: ++idRef.current,
          role: 'assistant',
          text: data.answer,
          courses: data.courses,
          sources: data.sources,
        },
      ]);
      // 服务端回传本轮生效的参考资料：有新附件时是新抽取的，否则是旧的。
      setAttachmentContext(data.attachmentContext ?? '');
      if (sentNamesRef.current.length > 0) {
        setRefFileNames(sentNamesRef.current);
      }
      sentNamesRef.current = [];
    },
    onError: () => {
      sentNamesRef.current = [];
    },
  });

  /** 把选中的文件/粘贴的内容加进待发送列表（数量与大小先在本地拦一道）。 */
  const addFiles = async (files: File[]) => {
    setAttachError('');
    const incoming = files.filter((f) => f.size > 0);
    if (incoming.length === 0) return;
    if (pending.length + incoming.length > MAX_PENDING_FILES) {
      setAttachError(m['ai_assistant.attach_too_many']());
      return;
    }
    const newImages = incoming.filter((f) =>
      f.type.startsWith('image/')
    ).length;
    const oldImages = pending.filter((p) => p.isImage).length;
    if (oldImages + newImages > MAX_PENDING_IMAGES) {
      setAttachError(m['ai_assistant.attach_too_many_images']());
      return;
    }
    try {
      const prepared: PendingAttachment[] = [];
      for (const file of incoming) {
        const id = ++idRef.current;
        if (file.type.startsWith('image/')) {
          prepared.push(await processImageFile(file, id));
        } else {
          const dataUrl = await fileToDataUrl(file);
          prepared.push({
            id,
            name: file.name,
            mime: file.type || 'application/octet-stream',
            base64: base64Of(dataUrl),
            size: file.size,
            isImage: false,
          });
        }
      }
      const totalBase64 = [...pending, ...prepared].reduce(
        (sum, p) => sum + p.base64.length,
        0
      );
      if (totalBase64 > 2_000_000) {
        setAttachError(m['ai_assistant.attach_too_large']());
        return;
      }
      setPending((prev) => [...prev, ...prepared]);
    } catch {
      setAttachError(m['ai_assistant.attach_failed']());
    }
  };

  /** 输入框粘贴：截图（clipboard image）与复制的文件都接。 */
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const files = items
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  };

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || mutation.isPending) return;
    const history = messages
      .slice(-20)
      .map((msg) => ({ role: msg.role, content: msg.text }));
    const attachments = pending.map((p) => ({
      name: p.name,
      mime: p.mime,
      base64: p.base64,
    }));
    const sentNames = pending.map((p) => p.name);
    sentNamesRef.current = sentNames;
    setMessages((prev) => [
      ...prev,
      {
        id: ++idRef.current,
        role: 'user',
        text: trimmed,
        attachments: sentNames.length > 0 ? sentNames : undefined,
      },
    ]);
    setInput('');
    setPending([]);
    mutation.mutate({
      query: trimmed,
      history,
      attachments: attachments.length > 0 ? attachments : undefined,
      attachmentContext: attachmentContext || undefined,
    });
  };

  // 图谱页带节点过来（/ai-assistant?q=请介绍一下「节点名」）：登录后自动发
  // 一次；发完把 q 从地址里去掉，刷新不再重发。
  const qSentRef = useRef(false);
  useEffect(() => {
    if (qSentRef.current || sessionPending || !session?.user) return;
    const q = new URLSearchParams(window.location.search).get('q');
    if (!q?.trim()) return;
    qSentRef.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    send(q.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPending, session]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, mutation.isPending]);

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <Header />
      <main className="flex-1 px-4 py-8">
        <div className="mx-auto max-w-3xl">
          <div className="mb-6 text-center">
            <h1 className="font-serif text-3xl font-normal tracking-tight sm:text-4xl">
              {m['ai_assistant.title']()}
            </h1>
            <p className="text-muted-foreground mx-auto mt-3 max-w-lg text-sm">
              {m['ai_assistant.description']()}
            </p>
          </div>

          {sessionPending ? null : !session?.user ? (
            // 大圆卡片 1：先验证身份，再对话。
            <div className="border-border bg-card mx-auto max-w-lg rounded-2xl border p-6 text-center">
              <h2 className="font-medium">
                {m['ai_assistant.login_required_title']()}
              </h2>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                {m['ai_assistant.login_required_description']()}
              </p>
              <Link
                href="/sign-in"
                className={cn(buttonVariants(), 'mt-5 rounded-full px-6')}
              >
                {m['ai_assistant.sign_in']()}
              </Link>
            </div>
          ) : (
            <>
              <div className="mb-4 flex items-center justify-center gap-3 text-xs">
                <span className="text-muted-foreground">
                  {m['ai_assistant.signed_in']()}
                </span>
                {messages.length > 0 && (
                  <button
                    type="button"
                    disabled={mutation.isPending}
                    onClick={() => {
                      setMessages([]);
                      setPending([]);
                      setAttachmentContext('');
                      setRefFileNames([]);
                      if (typeof window !== 'undefined') {
                        window.localStorage.removeItem(CHAT_STORAGE_KEY);
                        window.localStorage.removeItem(ATTACH_STORAGE_KEY);
                      }
                    }}
                    className="text-muted-foreground hover:text-primary underline disabled:opacity-50"
                  >
                    {m['ai_assistant.clear']()}
                  </button>
                )}
                {canGeneratePpt && (
                  <button
                    type="button"
                    disabled={messages.length === 0 || pptMutation.isPending}
                    title={
                      messages.length === 0
                        ? m['ai_assistant.ppt_no_content']()
                        : undefined
                    }
                    onClick={openPptDialog}
                    className="text-muted-foreground hover:text-primary underline disabled:opacity-50"
                  >
                    {m['ai_assistant.ppt_button']()}
                  </button>
                )}
              </div>

              {attachmentContext && refFileNames.length > 0 && (
                <p className="text-muted-foreground mb-4 text-center text-xs">
                  {m['ai_assistant.attach_active']({
                    names: refFileNames.join('、'),
                  })}
                </p>
              )}

              <div className="space-y-4">
                {messages.map((msg) =>
                  msg.role === 'user' ? (
                    <div key={msg.id} className="flex flex-col items-end">
                      <div className="bg-primary text-primary-foreground max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
                        {msg.text}
                      </div>
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="text-muted-foreground mt-1 max-w-[85%] text-right text-xs">
                          {m['ai_assistant.attach_sent']({
                            names: msg.attachments.join('、'),
                          })}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div key={msg.id} className="space-y-3">
                      <div className="border-border bg-card max-w-[95%] rounded-2xl rounded-bl-sm border px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
                        {msg.text}
                      </div>
                      {msg.courses?.map((course) => (
                        <CourseCard key={course.slug} course={course} />
                      ))}
                      {msg.sources?.map((source) => (
                        <SourceCard key={source.url} source={source} />
                      ))}
                    </div>
                  )
                )}
                {mutation.isPending && (
                  <div className="border-border bg-card text-muted-foreground max-w-[95%] rounded-2xl rounded-bl-sm border px-4 py-2.5 text-sm">
                    {m['ai_assistant.thinking']()}
                  </div>
                )}
                <div ref={bottomRef} />
              </div>

              {messages.length === 0 && (
                <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                  {TOPIC_KEYS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      disabled={mutation.isPending}
                      onClick={() => send(m[key]())}
                      className="border-border text-muted-foreground hover:text-primary rounded-full border px-2.5 py-1 text-xs disabled:opacity-50"
                    >
                      {m[key]()}
                    </button>
                  ))}
                </div>
              )}

              {mutation.isError && (
                <p className="mt-6 text-center text-sm text-red-600">
                  {mutation.error instanceof Error
                    ? mutation.error.message
                    : m['ai_assistant.error']()}
                </p>
              )}

              {attachError && (
                <p className="mt-6 text-center text-sm text-red-600">
                  {attachError}
                </p>
              )}

              {pptError && (
                <p className="mt-6 text-center text-sm text-red-600">
                  {pptError}
                </p>
              )}

              {pptJob && (
                <div className="border-border bg-card mx-auto mt-6 max-w-xl rounded-2xl border p-4 text-sm">
                  {pptJob.status === 'completed' ? (
                    <>
                      <p className="font-medium">
                        {m['ai_assistant.ppt_completed']()}
                        {pptJob.title ? `：${pptJob.title}` : ''}
                      </p>
                      {typeof pptJob.slideCount === 'number' && (
                        <p className="text-muted-foreground mt-1 text-xs">
                          {m['ai_assistant.ppt_slide_count']({
                            count: pptJob.slideCount,
                          })}
                        </p>
                      )}
                      {pptJob.downloadUrl && (
                        <a
                          href={pptJob.downloadUrl}
                          className="text-primary mt-3 inline-flex items-center gap-1.5 font-medium"
                        >
                          {m['ai_assistant.ppt_download']()} ↓
                        </a>
                      )}
                    </>
                  ) : pptJob.status === 'failed' ? (
                    <p className="text-red-600">
                      {pptJob.error || m['ai_assistant.error']()}
                    </p>
                  ) : (
                    <p className="text-muted-foreground">
                      {m['ai_assistant.ppt_generating']()}
                    </p>
                  )}
                </div>
              )}

              {pptJobs.filter((j) => j.jobId !== pptJob?.jobId).length > 0 && (
                <div className="border-border bg-card mx-auto mt-6 max-w-xl rounded-2xl border p-4 text-sm">
                  <p className="font-medium">
                    {m['ai_assistant.ppt_recent']()}
                  </p>
                  <ul className="mt-2 space-y-2">
                    {pptJobs
                      .filter((j) => j.jobId !== pptJob?.jobId)
                      .map((j) => (
                        <li
                          key={j.jobId}
                          className="flex items-center justify-between gap-3"
                        >
                          <span className="min-w-0 truncate">
                            {j.title || m['ai_assistant.ppt_completed']()}
                            {typeof j.slideCount === 'number' &&
                              `（${m['ai_assistant.ppt_slide_count']({
                                count: j.slideCount,
                              })}）`}
                          </span>
                          <a
                            href={j.downloadUrl}
                            className="text-primary shrink-0 font-medium"
                          >
                            {m['ai_assistant.ppt_download']()} ↓
                          </a>
                        </li>
                      ))}
                  </ul>
                </div>
              )}

              {pending.length > 0 && (
                <div className="mx-auto mt-6 flex max-w-xl flex-wrap gap-1.5">
                  {pending.map((p) => (
                    <span
                      key={p.id}
                      className="border-border bg-card inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
                    >
                      <span className="max-w-40 truncate" title={p.name}>
                        {p.name}（{formatFileSize(p.size)}）
                      </span>
                      <button
                        type="button"
                        disabled={mutation.isPending}
                        aria-label={m['ai_assistant.attach_remove']()}
                        onClick={() =>
                          setPending((prev) =>
                            prev.filter((x) => x.id !== p.id)
                          )
                        }
                        className="text-muted-foreground hover:text-primary disabled:opacity-50"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  send(input);
                }}
                className="mx-auto mt-6 flex max-w-xl gap-2"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={ATTACH_ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    void addFiles(files);
                  }}
                />
                <button
                  type="button"
                  disabled={mutation.isPending}
                  title={m['ai_assistant.attach_title']()}
                  aria-label={m['ai_assistant.attach_title']()}
                  onClick={() => fileInputRef.current?.click()}
                  className="border-border bg-card text-muted-foreground hover:text-primary shrink-0 rounded-full border px-3.5 py-2 text-sm disabled:opacity-50"
                >
                  +
                </button>
                <input
                  type="search"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onPaste={handlePaste}
                  placeholder={m['ai_assistant.chat_placeholder']()}
                  maxLength={200}
                  className="border-border bg-card min-w-0 flex-1 rounded-full border px-4 py-2 text-sm"
                />
                <button
                  type="submit"
                  disabled={mutation.isPending || !input.trim()}
                  className={cn(
                    buttonVariants(),
                    'shrink-0 rounded-full px-5 disabled:opacity-50'
                  )}
                >
                  {m['ai_assistant.send']()}
                </button>
              </form>
              <p className="text-muted-foreground mx-auto mt-2 max-w-xl text-center text-xs">
                {m['ai_assistant.attach_hint']()}
              </p>

              <Dialog open={pptDialogOpen} onOpenChange={setPptDialogOpen}>
                <DialogContent className="sm:max-w-lg">
                  <DialogHeader>
                    <DialogTitle>
                      {m['ai_assistant.ppt_dialog_title']()}
                    </DialogTitle>
                    <DialogDescription>
                      {m['ai_assistant.ppt_dialog_description']()}
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="ppt-content">
                        {m['ai_assistant.ppt_content_label']()}
                      </Label>
                      <Textarea
                        id="ppt-content"
                        value={pptContent}
                        onChange={(e) => setPptContent(e.target.value)}
                        rows={8}
                      />
                    </div>
                    <div className="flex gap-4">
                      <div className="flex-1 space-y-2">
                        <Label htmlFor="ppt-slides">
                          {m['ai_assistant.ppt_slides_label']()}
                        </Label>
                        <Input
                          id="ppt-slides"
                          type="number"
                          min={1}
                          max={50}
                          value={pptSlides}
                          onChange={(e) => setPptSlides(e.target.value)}
                        />
                      </div>
                      <div className="flex-1 space-y-2">
                        <Label htmlFor="ppt-mode">
                          {m['ai_assistant.ppt_mode_label']()}
                        </Label>
                        <Select
                          value={pptMode}
                          onValueChange={(v) =>
                            setPptMode(v === 'smart' ? 'smart' : 'standard')
                          }
                        >
                          <SelectTrigger id="ppt-mode">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="standard">
                              {m['ai_assistant.ppt_mode_standard']()}
                            </SelectItem>
                            <SelectItem value="smart">
                              {m['ai_assistant.ppt_mode_smart']()}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="ppt-instructions">
                        {m['ai_assistant.ppt_instructions_label']()}
                      </Label>
                      <Input
                        id="ppt-instructions"
                        value={pptInstructions}
                        onChange={(e) => setPptInstructions(e.target.value)}
                        placeholder={m[
                          'ai_assistant.ppt_instructions_placeholder'
                        ]()}
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <button
                      type="button"
                      onClick={() => setPptDialogOpen(false)}
                      className={cn(
                        buttonVariants({ variant: 'outline' }),
                        'rounded-full px-5'
                      )}
                    >
                      {m['ai_assistant.ppt_cancel']()}
                    </button>
                    <button
                      type="button"
                      disabled={pptMutation.isPending || !pptContent.trim()}
                      onClick={() => {
                        setPptError('');
                        pptMutation.mutate({
                          content: pptContent,
                          nSlides: Math.min(
                            50,
                            Math.max(1, Number(pptSlides) || 6)
                          ),
                          mode: pptMode,
                          instructions: pptInstructions.trim() || undefined,
                        });
                      }}
                      className={cn(
                        buttonVariants(),
                        'rounded-full px-5 disabled:opacity-50'
                      )}
                    >
                      {m['ai_assistant.ppt_submit']()}
                    </button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
