import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

import { useSession } from '@/core/auth/client';
import { Link } from '@/core/i18n/navigation';
import { localizedAbsoluteUrl } from '@/core/i18n/urls';
import { envConfigs } from '@/config';
import { apiGet, apiPost } from '@/lib/api-client';
import { PPT_DEFAULT_TEMPLATE, PPT_TEMPLATES } from '@/lib/ppt-templates';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';
import { getLocale, locales } from '@/paraglide/runtime.js';
import { useUserPermissions } from '@/hooks/use-user-permissions';
import { buttonVariants } from '@/components/ui/button';
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

import {
  clearPptDraft,
  loadPptDraft,
  loadPptPrefs,
  loadStoredCurrentPptJob,
  loadStoredPptContent,
  loadStoredPptJobs,
  mergeOutlinePagesToOne,
  parsePptIntent,
  savePptPrefs,
  storeCurrentPptJob,
  storePptJob,
  type OutlinePageDraft,
  type PptIntent,
  type PptJobRecord,
  type PptJobStatus,
} from './-ppt-shared';

export const Route = createFileRoute('/ai-assistant/ppt')({
  loader: async () => {
    const locale = getLocale();
    return { locale };
  },
  head: ({ loaderData }) => {
    const locale = loaderData?.locale ?? 'zh';
    const urlFor = (loc: string) =>
      localizedAbsoluteUrl('/ai-assistant/ppt', loc);
    return {
      meta: [
        {
          title: `${m['ai_assistant.ppt_page_title']({}, { locale: locale as any })} | ${envConfigs.app_name}`,
        },
        {
          name: 'description',
          content: m['ai_assistant.ppt_page_description'](
            {},
            { locale: locale as any }
          ),
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
  component: PptPage,
});

function PptPage() {
  const { data: session, isPending: sessionPending } = useSession();

  // 生成 PPT：只对有 admin.presentations.generate 权限的角色开放
  // （服务端接口仍各自鉴权，这里只决定“显不显示”）。
  const { data: userPermissions } = useUserPermissions();
  const canGeneratePpt =
    userPermissions?.permissions?.includes('admin.presentations.generate') ??
    false;

  const [pptContent, setPptContent] = useState('');
  const [pptSlides, setPptSlides] = useState('6');
  const [pptMode, setPptMode] = useState<'standard' | 'smart'>('standard');
  const [pptTemplate, setPptTemplate] = useState(PPT_DEFAULT_TEMPLATE);
  const [pptTitlePage, setPptTitlePage] = useState(true);
  const [pptInstructions, setPptInstructions] = useState('');
  const [pptJob, setPptJob] = useState<PptJobStatus | null>(null);
  const [pptPolling, setPptPolling] = useState(false);
  const [pptError, setPptError] = useState('');
  /** 本机已完成的 PPT 任务（刷新后下载链接还在）。 */
  const [pptJobs, setPptJobs] = useState<PptJobRecord[]>([]);
  // outline 草稿（导航＋意图优化）：standard 生成一律先确认页面划分。
  const [outline, setOutline] = useState<{
    outlineId: string;
    pages: OutlinePageDraft[];
    sourceIds: string[];
  } | null>(null);
  /** 生成点击时从用户一句话里抽到的意图（草稿面板展示，可改）。 */
  const [intent, setIntent] = useState<PptIntent | null>(null);
  /** 生成点击时想要的页数（意图或表单值；与草稿页数不符时提示）。 */
  const [wantedSlides, setWantedSlides] = useState<number | null>(null);

  // 只在客户端跑：对话页对话框交接的草稿优先，其次按习惯预填，
  // 再其次从本机保存的对话拼默认内容；恢复已完成的任务列表与进行
  // 中的任务轮询（切换页签/刷新后不重跑生成）。
  useEffect(() => {
    const draft = loadPptDraft();
    const prefs = loadPptPrefs();
    if (draft) {
      setPptContent(draft.content);
      if (draft.nSlides) setPptSlides(draft.nSlides);
      if (draft.mode) setPptMode(draft.mode);
      if (draft.template) setPptTemplate(draft.template);
      if (typeof draft.titlePage === 'boolean')
        setPptTitlePage(draft.titlePage);
      if (draft.instructions) setPptInstructions(draft.instructions);
      clearPptDraft();
    } else {
      setPptContent(loadStoredPptContent());
      if (prefs.nSlides !== undefined) setPptSlides(String(prefs.nSlides));
      if (prefs.mode) setPptMode(prefs.mode);
      if (prefs.template) setPptTemplate(prefs.template);
      setPptTitlePage(prefs.titlePage ?? (prefs.nSlides ?? 6) > 1);
    }
    setPptJobs(loadStoredPptJobs());
    const current = loadStoredCurrentPptJob();
    if (current) {
      // 先立即查一次状态：已终态就直接展示结果，未终态再接上轮询。
      void apiGet<PptJobStatus>(
        `/api/ai-assistant/presentations?id=${encodeURIComponent(current.jobId)}`
      )
        .then((data) => {
          setPptJob(data);
          if (data.status === 'completed' || data.status === 'failed') {
            storeCurrentPptJob(null);
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
          } else {
            setPptPolling(true);
          }
        })
        .catch(() => {
          // 任务找不到了（已被删/不属主）：清掉恢复标记，不报错。
          storeCurrentPptJob(null);
        });
    }
  }, []);

  const pptMutation = useMutation({
    mutationFn: (vars: {
      content: string;
      nSlides: number;
      mode: 'standard' | 'smart';
      template?: string;
      titlePage?: boolean;
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
      storeCurrentPptJob(data.jobId);
    },
    onError: (e) => {
      setPptError(e instanceof Error ? e.message : m['ai_assistant.error']());
    },
  });

  // outline 草稿：standard 生成一律先建草稿（单页也是 1 页 outline），
  // 不再把整段提示直接丢给 Presenton。
  const outlineMutation = useMutation({
    mutationFn: (vars: { content: string }) =>
      apiPost<{
        outlineId: string;
        pages: OutlinePageDraft[];
        sourceIds: string[];
      }>('/api/ai-assistant/presentations/outline', {
        action: 'create',
        content: vars.content,
      }),
    onSuccess: (data) => {
      setOutline({
        outlineId: data.outlineId,
        pages: data.pages,
        sourceIds: data.sourceIds,
      });
    },
    onError: (e) => {
      setPptError(e instanceof Error ? e.message : m['ai_assistant.error']());
    },
  });

  // 确认草稿并生成：先确认 outline（可含调整后的 pages），再带
  // outlineId 生成。两步同一次点击完成，保持一键可用。
  const confirmMutation = useMutation({
    mutationFn: async (vars: {
      outlineId: string;
      pages: OutlinePageDraft[];
      sourceIds: string[];
    }) => {
      const confirmed = await apiPost<{
        outlineId: string;
        pages: OutlinePageDraft[];
        sourceIds: string[];
      }>('/api/ai-assistant/presentations/outline', {
        action: 'confirm',
        outlineId: vars.outlineId,
        pages: vars.pages,
      });
      const data = await apiPost<{ jobId: string; status: string }>(
        '/api/ai-assistant/presentations',
        {
          outlineId: confirmed.outlineId,
          sourceIds: confirmed.sourceIds,
          nSlides: confirmed.pages.length,
          mode: pptMode,
          template: pptMode === 'smart' ? undefined : pptTemplate,
          titlePage: pptTitlePage,
          instructions: pptInstructions.trim() || undefined,
        }
      );
      return { ...data, nSlides: confirmed.pages.length };
    },
    onSuccess: (data) => {
      setPptJob({
        jobId: data.jobId,
        status: data.status as PptJobStatus['status'],
      });
      setPptPolling(true);
      storeCurrentPptJob(data.jobId);
      // 习惯：这次的选择记下来，下次生成默认按它走。
      savePptPrefs({
        nSlides: data.nSlides,
        titlePage: pptTitlePage,
        mode: pptMode,
        template: pptMode === 'smart' ? undefined : pptTemplate,
      });
      setOutline(null);
      setIntent(null);
      setWantedSlides(null);
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
          if (data.status === 'completed' || data.status === 'failed') {
            setPptPolling(false);
            storeCurrentPptJob(null);
          }
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

  // “开始生成”：先从用户一句话里抽意图（要几页、要不要标题页），抽到
  // 的写回表单并在草稿面板展示；抽不到的按表单值走，草稿面板就是问
  // 句——用户确认或调整后再生成，绝不猜。smart 只适合单页快讯，无
  // outline 机制，直接生成；standard 一律先建 outline 草稿。
  const handleGenerateClick = () => {
    setPptError('');
    if (pptMode === 'smart') {
      savePptPrefs({
        nSlides: Math.min(50, Math.max(1, Number(pptSlides) || 1)),
        titlePage: pptTitlePage,
        mode: 'smart',
      });
      pptMutation.mutate({
        content: pptContent,
        nSlides: Math.min(50, Math.max(1, Number(pptSlides) || 1)),
        mode: 'smart',
        titlePage: pptTitlePage,
        instructions: pptInstructions.trim() || undefined,
      });
      return;
    }
    const parsed = parsePptIntent(`${pptContent}\n${pptInstructions}`);
    const wanted = parsed.nSlides ?? Math.min(50, Math.max(1, Number(pptSlides) || 6));
    const wantedTitle = parsed.titlePage ?? pptTitlePage;
    setIntent(parsed);
    setWantedSlides(wanted);
    setPptSlides(String(wanted));
    setPptTitlePage(wantedTitle);
    outlineMutation.mutate({ content: pptContent });
  };

  /** 草稿面板：改某页标题（确认时随 pages 一起发）。 */
  const updateOutlineTitle = (pageNo: number, title: string) => {
    setOutline((prev) =>
      prev
        ? {
            ...prev,
            pages: prev.pages.map((p) =>
              p.pageNo === pageNo ? { ...p, title } : p
            ),
          }
        : prev
    );
  };

  /** 草稿面板：删一页，剩余页重编号（确认要求页码连续）。 */
  const deleteOutlinePage = (pageNo: number) => {
    setOutline((prev) => {
      if (!prev || prev.pages.length <= 1) return prev;
      const pages = prev.pages
        .filter((p) => p.pageNo !== pageNo)
        .map((p, i) => ({ ...p, pageNo: i + 1 }));
      return { ...prev, pages };
    });
  };

  /** 草稿面板：用户只要 1 页、草稿却划出多页时，并成 1 页再确认。 */
  const mergeOutlineToOne = () => {
    setOutline((prev) =>
      prev ? { ...prev, pages: mergeOutlinePagesToOne(prev.pages) } : prev
    );
  };

  /** 草稿面板展示的意图摘要，如“1 页、不保留标题页”。 */
  const intentSummary = (() => {
    if (!intent) return '';
    const parts: string[] = [];
    if (intent.nSlides !== undefined)
      parts.push(
        m['ai_assistant.ppt_slide_count']({ count: intent.nSlides })
      );
    if (intent.titlePage !== undefined)
      parts.push(
        intent.titlePage
          ? m['ai_assistant.ppt_title_page_keep']()
          : m['ai_assistant.ppt_title_page_none']()
      );
    return parts.join(getLocale() === 'zh' ? '、' : ', ');
  })();

  return (
    <div className="mx-auto max-w-3xl">
          <div className="mt-4 mb-6 text-center">
            <h1 className="font-serif text-3xl font-normal tracking-tight sm:text-4xl">
              {m['ai_assistant.ppt_page_title']()}
            </h1>
            <p className="text-muted-foreground mx-auto mt-3 max-w-lg text-sm">
              {m['ai_assistant.ppt_page_description']()}
            </p>
          </div>

          {sessionPending ? null : !session?.user ? (
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
          ) : !canGeneratePpt ? (
            <p className="text-muted-foreground mx-auto max-w-lg text-center text-sm">
              {m['ai_assistant.ppt_no_permission']()}
            </p>
          ) : (
            <>
              <div className="border-border bg-card mx-auto max-w-xl rounded-2xl border p-6">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="ppt-page-content">
                      {m['ai_assistant.ppt_content_label']()}
                    </Label>
                    <Textarea
                      id="ppt-page-content"
                      value={pptContent}
                      onChange={(e) => setPptContent(e.target.value)}
                      rows={10}
                    />
                  </div>
                  <div className="flex gap-4">
                    <div className="flex-1 space-y-2">
                      <Label htmlFor="ppt-page-slides">
                        {m['ai_assistant.ppt_slides_label']()}
                      </Label>
                      <Input
                        id="ppt-page-slides"
                        type="number"
                        min={1}
                        max={50}
                        value={pptSlides}
                        onChange={(e) => setPptSlides(e.target.value)}
                      />
                    </div>
                    <div className="flex-1 space-y-2">
                      <Label htmlFor="ppt-page-mode">
                        {m['ai_assistant.ppt_mode_label']()}
                      </Label>
                      <Select
                        value={pptMode}
                        onValueChange={(v) =>
                          setPptMode(v === 'smart' ? 'smart' : 'standard')
                        }
                      >
                        <SelectTrigger id="ppt-page-mode">
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
                    <Label htmlFor="ppt-page-template">
                      {m['ai_assistant.ppt_template_label']()}
                    </Label>
                    <Select
                      value={pptTemplate}
                      disabled={pptMode === 'smart'}
                      onValueChange={(v) => setPptTemplate(v)}
                    >
                      <SelectTrigger id="ppt-page-template">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PPT_TEMPLATES.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-muted-foreground text-xs">
                      {pptMode === 'smart'
                        ? m['ai_assistant.ppt_template_smart_note']()
                        : m['ai_assistant.ppt_template_hint']()}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ppt-page-title-page">
                      {m['ai_assistant.ppt_title_page_label']()}
                    </Label>
                    <Select
                      value={pptTitlePage ? 'keep' : 'none'}
                      onValueChange={(v) => setPptTitlePage(v === 'keep')}
                    >
                      <SelectTrigger id="ppt-page-title-page">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="keep">
                          {m['ai_assistant.ppt_title_page_keep']()}
                        </SelectItem>
                        <SelectItem value="none">
                          {m['ai_assistant.ppt_title_page_none']()}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ppt-page-instructions">
                      {m['ai_assistant.ppt_instructions_label']()}
                    </Label>
                    <Input
                      id="ppt-page-instructions"
                      value={pptInstructions}
                      onChange={(e) => setPptInstructions(e.target.value)}
                      placeholder={m[
                        'ai_assistant.ppt_instructions_placeholder'
                      ]()}
                    />
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      disabled={
                        pptMutation.isPending ||
                        outlineMutation.isPending ||
                        !pptContent.trim()
                      }
                      onClick={handleGenerateClick}
                      className={cn(
                        buttonVariants(),
                        'rounded-full px-6 disabled:opacity-50'
                      )}
                    >
                      {m['ai_assistant.ppt_submit']()}
                    </button>
                  </div>
                </div>
              </div>

              {outlineMutation.isPending && (
                <p className="text-muted-foreground mt-6 text-center text-sm">
                  {m['ai_assistant.ppt_outline_creating']()}
                </p>
              )}

              {outline && (
                <div className="border-border bg-card mx-auto mt-6 max-w-xl rounded-2xl border p-4 text-sm">
                  <p className="font-medium">
                    {m['ai_assistant.ppt_outline_title']()}
                  </p>
                  {intentSummary && (
                    <p className="text-muted-foreground mt-1 text-xs">
                      {m['ai_assistant.ppt_outline_intent']({
                        summary: intentSummary,
                      })}
                    </p>
                  )}
                  {wantedSlides !== null &&
                    outline.pages.length !== wantedSlides && (
                      <p className="mt-1 text-xs text-amber-600">
                        {m['ai_assistant.ppt_outline_count_mismatch']({
                          actual: outline.pages.length,
                          wanted: wantedSlides,
                        })}
                      </p>
                    )}
                  <ul className="mt-3 space-y-3">
                    {outline.pages.map((page) => (
                      <li
                        key={page.pageNo}
                        className="border-border rounded-xl border p-3"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground shrink-0 text-xs">
                            {page.pageNo}
                          </span>
                          <input
                            value={page.title}
                            onChange={(e) =>
                              updateOutlineTitle(page.pageNo, e.target.value)
                            }
                            className="border-border bg-background min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"
                          />
                          {outline.pages.length > 1 && (
                            <button
                              type="button"
                              aria-label="删除本页"
                              onClick={() => deleteOutlinePage(page.pageNo)}
                              className="text-muted-foreground hover:text-primary shrink-0"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                        <ul className="text-muted-foreground mt-2 list-disc space-y-0.5 pl-8 text-xs">
                          {page.points.map((point, i) => (
                            <li key={i}>{point}</li>
                          ))}
                        </ul>
                        <p className="text-muted-foreground mt-1 pl-8 text-xs">
                          {page.layoutReason}
                        </p>
                        {page.insufficient && (
                          <p className="mt-1 pl-8 text-xs text-amber-600">
                            {m['ai_assistant.ppt_outline_insufficient']()}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-4 flex flex-wrap justify-end gap-2">
                    {wantedSlides === 1 && outline.pages.length > 1 && (
                      <button
                        type="button"
                        onClick={mergeOutlineToOne}
                        className={cn(
                          buttonVariants({ variant: 'outline' }),
                          'rounded-full px-4'
                        )}
                      >
                        {m['ai_assistant.ppt_outline_merge_one']()}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setOutline(null);
                        setIntent(null);
                        setWantedSlides(null);
                      }}
                      className={cn(
                        buttonVariants({ variant: 'outline' }),
                        'rounded-full px-4'
                      )}
                    >
                      {m['ai_assistant.ppt_outline_back']()}
                    </button>
                    <button
                      type="button"
                      disabled={confirmMutation.isPending}
                      onClick={() =>
                        confirmMutation.mutate({
                          outlineId: outline.outlineId,
                          pages: outline.pages,
                          sourceIds: outline.sourceIds,
                        })
                      }
                      className={cn(
                        buttonVariants(),
                        'rounded-full px-4 disabled:opacity-50'
                      )}
                    >
                      {m['ai_assistant.ppt_outline_confirm']()}
                    </button>
                  </div>
                </div>
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
            </>
          )}
    </div>
  );
}
