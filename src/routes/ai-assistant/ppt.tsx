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
import { Footer } from '@/blocks/footer';
import { Header } from '@/blocks/header';
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
  loadStoredPptContent,
  loadStoredPptJobs,
  storePptJob,
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
  const [pptInstructions, setPptInstructions] = useState('');
  const [pptJob, setPptJob] = useState<PptJobStatus | null>(null);
  const [pptPolling, setPptPolling] = useState(false);
  const [pptError, setPptError] = useState('');
  /** 本机已完成的 PPT 任务（刷新后下载链接还在）。 */
  const [pptJobs, setPptJobs] = useState<PptJobRecord[]>([]);

  // 只在客户端跑：从本机保存的对话拼默认内容、恢复已完成的任务列表。
  useEffect(() => {
    setPptContent(loadStoredPptContent());
    setPptJobs(loadStoredPptJobs());
  }, []);

  const pptMutation = useMutation({
    mutationFn: (vars: {
      content: string;
      nSlides: number;
      mode: 'standard' | 'smart';
      template?: string;
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

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <Header />
      <main className="flex-1 px-4 py-8">
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
                          template:
                            pptMode === 'smart' ? undefined : pptTemplate,
                          instructions: pptInstructions.trim() || undefined,
                        });
                      }}
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
      </main>
      <Footer />
    </div>
  );
}
