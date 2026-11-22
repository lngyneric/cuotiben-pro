import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

import { useSession } from '@/core/auth/client';
import { Link } from '@/core/i18n/navigation';
import { localizedAbsoluteUrl } from '@/core/i18n/urls';
import { envConfigs } from '@/config';
import { ApiError, apiGet } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';
import { getLocale, locales } from '@/paraglide/runtime.js';
import { Footer } from '@/blocks/footer';
import { Header } from '@/blocks/header';
import { DataTable, type Column } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// 学分制带教 Dashboard —— 总表（管理员 / HR / 导师）。
//
// 数据取自 /api/mentoring-dashboard/summary（只读 user_status_summary）。
// 视角：管理员可切管理员 / HR / 导师三个视角；导师只能看导师视角（自己名下学员）。
// HR 在 wiki 里目前没有独立角色，hr 视角仅管理员可预览。

type DashboardView = 'admin' | 'hr' | 'mentor';

interface MentoringRow {
  id: string;
  name: string;
  employeeNo: string | null;
  department: string | null;
  positionName: string | null;
  mentorLeadName: string | null;
  planType: string | null;
  planStartDate: string | null;
  planEndDate: string | null;
  expectedDate: string | null;
  status: string | null;
  result: string | null;
  scores: {
    process: number | null;
    gpa: number | null;
    elearn: number | null;
  } | null;
  flags: string[];
  completedNodes: number;
  totalNodes: number;
  coursesCount: number;
  progressRecords: number;
  quizAttempts: number;
  lastActivityAt: string | null;
  computedAt: string | null;
}

interface MentorOption {
  id: string;
  name: string;
  employeeNo: string | null;
  menteeCount: number;
}

interface SummaryData {
  view: DashboardView;
  scope: 'admin' | 'mentor';
  rows: MentoringRow[];
  summary: {
    total: number;
    byStatus: Record<string, number>;
    byPlanType: Record<string, number>;
    overdue: number;
    pendingConfirm: number;
    noCourseActivity: number;
    noWikiAccount: number;
  };
  mentors: MentorOption[];
  computedAt: string | null;
}

const PAGE_SIZE = 20;

function hrFollowUpLabel(flag: string): string {
  if (flag === 'overdue')
    return m['mentoring_dashboard.hr_follow_up_overdue']();
  if (flag === 'pending_confirm')
    return m['mentoring_dashboard.hr_follow_up_pending_confirm']();
  if (flag === 'unresolved_identity')
    return m['mentoring_dashboard.hr_follow_up_unresolved_identity']();
  if (flag === 'no_course_activity')
    return m['mentoring_dashboard.hr_follow_up_no_course_activity']();
  if (flag === 'no_wiki_account')
    return m['mentoring_dashboard.hr_follow_up_no_wiki_account']();
  return flag;
}

/** HR 跟进项：只从已有 flags 派生，顺序固定。 */
function hrFollowUpItems(row: MentoringRow): string[] {
  const order = [
    'overdue',
    'pending_confirm',
    'unresolved_identity',
    'no_course_activity',
    'no_wiki_account',
  ];
  return order.filter((f) => row.flags.includes(f));
}

function shortDate(v: string | null): string {
  return v ? v.slice(0, 10) : '—';
}

function statusBadgeVariant(
  status: string | null
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === '完成') return 'secondary';
  if (status === '中断') return 'destructive';
  return 'outline';
}

export const Route = createFileRoute('/mentoring-dashboard')({
  loader: async () => {
    const locale = getLocale();
    return { locale };
  },
  head: ({ loaderData }) => {
    const locale = loaderData?.locale ?? 'zh';
    const urlFor = (loc: string) =>
      localizedAbsoluteUrl('/mentoring-dashboard', loc);
    return {
      meta: [
        {
          title: `${m['mentoring_dashboard.title']({}, { locale: locale as any })} | ${envConfigs.app_name}`,
        },
        {
          name: 'description',
          content: m['mentoring_dashboard.description'](
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
  component: MentoringDashboardPage,
});

function MentoringDashboardPage() {
  const { data: session, isPending: sessionPending } = useSession();
  const [view, setView] = useState<DashboardView>('admin');
  const [previewMentorId, setPreviewMentorId] = useState<string | null>(null);
  const [planType, setPlanType] = useState('all');
  const [status, setStatus] = useState('all');
  const [mentorLead, setMentorLead] = useState('all');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const needMentor = view === 'mentor' && !previewMentorId;
  const summaryQ = useQuery({
    queryKey: ['mentoring-dashboard-summary', view, previewMentorId],
    queryFn: () => {
      const q = new URLSearchParams({ view });
      if (view === 'mentor' && previewMentorId)
        q.set('mentorId', previewMentorId);
      return apiGet<SummaryData>(
        `/api/mentoring-dashboard/summary?${q.toString()}`
      );
    },
    staleTime: 60_000,
    retry: false,
    enabled: !!session?.user && !needMentor,
  });

  const data = summaryQ.data;
  const isAdminScope = data?.scope === 'admin';
  const effectiveView: DashboardView = data?.view ?? view;

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const planTypes = useMemo(
    () => Object.keys(data?.summary.byPlanType ?? {}).sort(),
    [data]
  );
  const statuses = useMemo(
    () => Object.keys(data?.summary.byStatus ?? {}).sort(),
    [data]
  );
  const mentorLeads = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.mentorLeadName) set.add(r.mentorLeadName);
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (planType !== 'all' && r.planType !== planType) return false;
      if (status !== 'all' && (r.status ?? '—') !== status) return false;
      if (mentorLead !== 'all' && r.mentorLeadName !== mentorLead) return false;
      if (overdueOnly && !r.flags.includes('overdue')) return false;
      if (q) {
        const hay = `${r.name} ${r.employeeNo ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, planType, status, mentorLead, overdueOnly, search]);

  const pageRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  const columns = useMemo<Column<MentoringRow>[]>(() => {
    const cols: Column<MentoringRow>[] = [
      {
        header: m['mentoring_dashboard.col_name'](),
        cell: (r) => (
          <Link
            href={`/mentoring-dashboard/${encodeURIComponent(r.id)}`}
            className="font-medium hover:underline"
          >
            {r.name}
          </Link>
        ),
      },
      {
        header: m['mentoring_dashboard.col_employee_no'](),
        cell: (r) => r.employeeNo ?? '—',
      },
      {
        header: m['mentoring_dashboard.col_department'](),
        cell: (r) => r.department ?? '—',
      },
      {
        header: m['mentoring_dashboard.col_plan_type'](),
        cell: (r) => r.planType ?? '—',
      },
      {
        header: m['mentoring_dashboard.col_period'](),
        cell: (r) =>
          `${shortDate(r.planStartDate)} ~ ${shortDate(r.planEndDate)}`,
      },
      {
        header: m['mentoring_dashboard.col_expected_date'](),
        cell: (r) => shortDate(r.expectedDate),
      },
      {
        header: m['mentoring_dashboard.col_status'](),
        cell: (r) => (
          <Badge variant={statusBadgeVariant(r.status)}>
            {r.status ?? '—'}
          </Badge>
        ),
      },
      {
        header: m['mentoring_dashboard.col_completion'](),
        cell: (r) => {
          const pct =
            r.totalNodes > 0
              ? Math.round((r.completedNodes / r.totalNodes) * 100)
              : 0;
          return (
            <div className="flex min-w-20 items-center gap-2">
              <Progress value={pct} className="h-1.5 w-12" />
              <span className="text-xs whitespace-nowrap">
                {r.completedNodes}/{r.totalNodes}
              </span>
            </div>
          );
        },
      },
      {
        header: m['mentoring_dashboard.col_overdue'](),
        cell: (r) =>
          r.flags.includes('overdue') ? (
            <Badge variant="destructive">
              {m['mentoring_dashboard.flag_overdue']()}
            </Badge>
          ) : (
            '—'
          ),
      },
      {
        header: m['mentoring_dashboard.col_mentor_lead'](),
        cell: (r) => r.mentorLeadName ?? '—',
      },
    ];
    if (effectiveView === 'hr') {
      cols.push({
        header: m['mentoring_dashboard.col_hr_follow_up'](),
        cell: (r) => {
          const items = hrFollowUpItems(r);
          return items.length > 0 ? items.map(hrFollowUpLabel).join('、') : '—';
        },
      });
    }
    return cols;
  }, [effectiveView]);

  function resetPage() {
    setPage(1);
  }

  // 未登录：提示登录（与图谱页一致）。
  if (!sessionPending && !session?.user) {
    return (
      <div className="bg-background text-foreground flex min-h-screen flex-col">
        <Header />
        <main className="flex-1 px-4 py-8">
          <div className="border-border bg-card mx-auto max-w-lg rounded-2xl border p-6 text-center">
            <h1 className="font-medium">
              {m['ai_assistant.login_required_title']()}
            </h1>
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
        </main>
        <Footer />
      </div>
    );
  }

  const forbidden =
    summaryQ.error instanceof ApiError &&
    summaryQ.error.message === 'Forbidden';

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {m['mentoring_dashboard.title']()}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {m['mentoring_dashboard.description']()}
          </p>
        </div>

        {forbidden ? (
          <Card className="mt-6">
            <CardContent className="py-10 text-center">
              <h2 className="font-medium">
                {m['mentoring_dashboard.forbidden_title']()}
              </h2>
              <p className="text-muted-foreground mt-2 text-sm">
                {m['mentoring_dashboard.forbidden_description']()}
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* 角色视角切换：仅管理员可见；导师固定为导师视角。 */}
            {isAdminScope && (
              <div className="mt-6 flex flex-wrap items-center gap-2">
                {(['admin', 'hr', 'mentor'] as DashboardView[]).map((v) => (
                  <Button
                    key={v}
                    variant={view === v ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => {
                      setView(v);
                      setPage(1);
                      if (v !== 'mentor') setPreviewMentorId(null);
                    }}
                  >
                    {v === 'admin'
                      ? m['mentoring_dashboard.view_admin']()
                      : v === 'hr'
                        ? m['mentoring_dashboard.view_hr']()
                        : m['mentoring_dashboard.view_mentor']()}
                  </Button>
                ))}
                <span className="text-muted-foreground text-xs">
                  {m['mentoring_dashboard.admin_preview_note']()}
                </span>
              </div>
            )}
            {!isAdminScope && data && (
              <p className="text-muted-foreground mt-6 text-xs">
                {m['mentoring_dashboard.mentor_view_note']()}
              </p>
            )}

            {/* 导师视角：管理员须选一位导师预览。 */}
            {isAdminScope && view === 'mentor' && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Select
                  value={previewMentorId ?? ''}
                  onValueChange={(v) => {
                    setPreviewMentorId(v || null);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="w-64">
                    <SelectValue
                      placeholder={m[
                        'mentoring_dashboard.preview_mentor_placeholder'
                      ]()}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(data?.mentors ?? []).map((mt) => (
                      <SelectItem key={mt.id} value={mt.id}>
                        {mt.name}
                        {mt.employeeNo ? `（${mt.employeeNo}）` : ''} ·{' '}
                        {m['mentoring_dashboard.mentee_count']({
                          count: mt.menteeCount,
                        })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground text-xs">
                  {m['mentoring_dashboard.preview_mentor_hint']()}
                </span>
              </div>
            )}

            {/* 汇总卡片（未选导师时不展示旧视角数据） */}
            {data && !needMentor && (
              <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-5">
                <Card>
                  <CardHeader className="pb-1">
                    <CardTitle className="text-muted-foreground text-sm font-normal">
                      {m['mentoring_dashboard.cards_total']()}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-semibold">
                    {data.summary.total}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-1">
                    <CardTitle className="text-muted-foreground text-sm font-normal">
                      {m['mentoring_dashboard.cards_completed']()}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-semibold">
                    {data.summary.byStatus['完成'] ?? 0}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-1">
                    <CardTitle className="text-muted-foreground text-sm font-normal">
                      {m['mentoring_dashboard.cards_overdue']()}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-semibold">
                    {data.summary.overdue}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-1">
                    <CardTitle className="text-muted-foreground text-sm font-normal">
                      {m['mentoring_dashboard.cards_pending_confirm']()}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-semibold">
                    {data.summary.pendingConfirm}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-1">
                    <CardTitle className="text-muted-foreground text-sm font-normal">
                      {m['mentoring_dashboard.cards_no_course_activity']()}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-semibold">
                    {data.summary.noCourseActivity}
                  </CardContent>
                </Card>
              </div>
            )}

            {/* 筛选（未选导师时不展示） */}
            {!needMentor && (
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <Select
                  value={planType}
                  onValueChange={(v) => {
                    setPlanType(v ?? 'all');
                    resetPage();
                  }}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue
                      placeholder={m['mentoring_dashboard.filter_plan_type']()}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      {m['mentoring_dashboard.filter_all']()}
                    </SelectItem>
                    {planTypes.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={status}
                  onValueChange={(v) => {
                    setStatus(v ?? 'all');
                    resetPage();
                  }}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue
                      placeholder={m['mentoring_dashboard.filter_status']()}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">
                      {m['mentoring_dashboard.filter_all']()}
                    </SelectItem>
                    {statuses.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {effectiveView !== 'mentor' && (
                  <Select
                    value={mentorLead}
                    onValueChange={(v) => {
                      setMentorLead(v ?? 'all');
                      resetPage();
                    }}
                  >
                    <SelectTrigger className="w-44">
                      <SelectValue
                        placeholder={m['mentoring_dashboard.filter_mentor']()}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        {m['mentoring_dashboard.filter_all']()}
                      </SelectItem>
                      {mentorLeads.map((n) => (
                        <SelectItem key={n} value={n}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={overdueOnly}
                    onCheckedChange={(v) => {
                      setOverdueOnly(v === true);
                      resetPage();
                    }}
                  />
                  {m['mentoring_dashboard.filter_overdue_only']()}
                </label>
              </div>
            )}

            {data?.computedAt && !needMentor && (
              <p className="text-muted-foreground mt-4 text-xs">
                {m['mentoring_dashboard.updated_at']({
                  time: new Date(data.computedAt).toLocaleString(),
                })}
              </p>
            )}

            {/* 总表 */}
            {needMentor ? (
              <Card className="mt-4">
                <CardContent className="text-muted-foreground py-10 text-center text-sm">
                  {m['mentoring_dashboard.preview_mentor_hint']()}
                </CardContent>
              </Card>
            ) : (
              <div className="mt-4">
                <DataTable
                  columns={columns}
                  data={pageRows}
                  total={filtered.length}
                  page={page}
                  pageSize={PAGE_SIZE}
                  onPageChange={setPage}
                  search={search}
                  onSearchChange={(v) => {
                    setSearch(v);
                    resetPage();
                  }}
                  searchPlaceholder={m[
                    'mentoring_dashboard.search_placeholder'
                  ]()}
                  emptyText={m['mentoring_dashboard.empty_rows']()}
                  rowKey={(r) => r.id}
                  loading={summaryQ.isFetching}
                  onRefresh={() => summaryQ.refetch()}
                />
              </div>
            )}
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
