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
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// 学分制带教 Dashboard —— 个人 Dashboard（一行带教记录，3 个确认节点）。
//
// 数据取自 /api/mentoring-dashboard/person/:recordId（只读 user_status_summary）。
// 每节点一行：计划（节点名＋计划类型）、预期（节点预计日期未记录，显示 —）、
// 完成度（确认状态）、里程碑（节点即里程碑）。

type NodeState = 'passed' | 'confirmed' | 'pending';

interface NodeCompletion {
  node: string;
  expected: string | null;
  state: NodeState;
  passed: string | null;
  confirmedAt: string | null;
  comments: {
    lead: string | null;
    keyAccount: string | null;
    exempt: string | null;
  };
}

interface Confirmation {
  node: string | null;
  timeNode: string | null;
  passed: string | null;
  confirmedAt: string | null;
  comments: {
    lead: string | null;
    keyAccount: string | null;
    exempt: string | null;
  };
}

interface MentoringPerson {
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
  /** E-learning 类型（智能表 `E-learning` 列：通过 / 离职 / 待考核 / 转岗）。 */
  elearnType: string | null;
  flags: string[];
  completedNodes: number;
  totalNodes: number;
  coursesCount: number;
  progressRecords: number;
  quizAttempts: number;
  lastActivityAt: string | null;
  computedAt: string | null;
  nodes: NodeCompletion[];
  confirmations: Confirmation[];
  nodeRatings: string | null;
  courses: {
    shifuBid: string;
    status: string | null;
    progressPct: number | null;
    deadline: string | null;
  }[];
}

function shortDate(v: string | null): string {
  return v ? v.slice(0, 10) : '—';
}

function nodeStateLabel(state: NodeState): string {
  if (state === 'passed') return m['mentoring_dashboard.node_state_passed']();
  if (state === 'confirmed')
    return m['mentoring_dashboard.node_state_confirmed']();
  return m['mentoring_dashboard.node_state_pending']();
}

function milestoneLabel(state: NodeState): string {
  if (state === 'passed') return m['mentoring_dashboard.milestone_achieved']();
  if (state === 'confirmed')
    return m['mentoring_dashboard.milestone_in_progress']();
  return m['mentoring_dashboard.milestone_not_started']();
}

function statusBadgeVariant(
  status: string | null
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === '完成') return 'secondary';
  if (status === '中断') return 'destructive';
  return 'outline';
}

export const Route = createFileRoute('/mentoring-dashboard/$recordId')({
  loader: async ({ params }) => {
    const locale = getLocale();
    return { locale, recordId: params.recordId };
  },
  head: ({ loaderData }) => {
    const locale = loaderData?.locale ?? 'zh';
    const recordId = loaderData?.recordId ?? '';
    const urlFor = (loc: string) =>
      localizedAbsoluteUrl(`/mentoring-dashboard/${recordId}`, loc);
    return {
      meta: [
        {
          title: `${m['mentoring_dashboard.person_title']({}, { locale: locale as any })} | ${envConfigs.app_name}`,
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
  component: MentoringPersonPage,
});

function MentoringPersonPage() {
  const { recordId } = Route.useLoaderData();
  const { data: session, isPending: sessionPending } = useSession();
  const personQ = useQuery({
    queryKey: ['mentoring-dashboard-person', recordId],
    queryFn: () =>
      apiGet<MentoringPerson>(
        `/api/mentoring-dashboard/person/${encodeURIComponent(recordId)}`
      ),
    staleTime: 60_000,
    retry: false,
    enabled: !!session?.user,
  });

  const person = personQ.data;
  const err = personQ.error;
  const notFound = err instanceof ApiError && err.message === 'Not found';
  const forbidden = err instanceof ApiError && err.message === 'Forbidden';

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

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <Link
          href="/mentoring-dashboard"
          className="text-muted-foreground text-sm hover:underline"
        >
          ← {m['mentoring_dashboard.back_to_summary']()}
        </Link>

        {notFound || forbidden ? (
          <Card className="mt-6">
            <CardContent className="py-10 text-center">
              <h2 className="font-medium">
                {notFound
                  ? m['mentoring_dashboard.not_found_title']()
                  : m['mentoring_dashboard.forbidden_title']()}
              </h2>
              <p className="text-muted-foreground mt-2 text-sm">
                {notFound
                  ? m['mentoring_dashboard.not_found_description']()
                  : m['mentoring_dashboard.forbidden_description']()}
              </p>
            </CardContent>
          </Card>
        ) : person ? (
          <>
            {/* 抬头卡 */}
            <Card className="mt-4">
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-xl">{person.name}</CardTitle>
                  <Badge variant={statusBadgeVariant(person.status)}>
                    {person.status ?? '—'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-4">
                  <div>
                    <dt className="text-muted-foreground">
                      {m['mentoring_dashboard.col_employee_no']()}
                    </dt>
                    <dd>{person.employeeNo ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {m['mentoring_dashboard.col_department']()}
                    </dt>
                    <dd>{person.department ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {m['mentoring_dashboard.col_plan_type']()}
                    </dt>
                    <dd>{person.planType ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {m['mentoring_dashboard.col_mentor_lead']()}
                    </dt>
                    <dd>{person.mentorLeadName ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {m['mentoring_dashboard.col_period']()}
                    </dt>
                    <dd>
                      {shortDate(person.planStartDate)} ~{' '}
                      {shortDate(person.planEndDate)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {m['mentoring_dashboard.col_expected_date']()}
                    </dt>
                    <dd>{shortDate(person.expectedDate)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {m['mentoring_dashboard.result']()}
                    </dt>
                    <dd>{person.result ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {m['mentoring_dashboard.col_completion']()}
                    </dt>
                    <dd className="flex items-center gap-2">
                      <Progress
                        value={
                          person.totalNodes > 0
                            ? Math.round(
                                (person.completedNodes / person.totalNodes) *
                                  100
                              )
                            : 0
                        }
                        className="h-1.5 w-16"
                      />
                      {person.completedNodes}/{person.totalNodes}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {m['mentoring_dashboard.col_overdue']()}
                    </dt>
                    <dd>
                      {person.flags.includes('overdue') ? (
                        <Badge variant="destructive">
                          {m['mentoring_dashboard.flag_overdue']()}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                </dl>
                <div className="grid grid-cols-3 gap-3 border-t pt-4">
                  <div>
                    <div className="text-muted-foreground text-xs">
                      {m['mentoring_dashboard.scores_process']()}
                    </div>
                    <div className="text-lg font-semibold">
                      {person.scores?.process ?? '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-xs">
                      {m['mentoring_dashboard.scores_gpa']()}
                    </div>
                    <div className="text-lg font-semibold">
                      {person.scores?.gpa ?? '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-xs">
                      {m['mentoring_dashboard.scores_elearn']()}
                    </div>
                    <div className="text-lg font-semibold">
                      {person.scores?.elearn ?? '—'}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {m['mentoring_dashboard.col_elearn_type']()}：
                      {person.elearnType ?? '—'}
                    </div>
                  </div>
                </div>
                {person.computedAt && (
                  <p className="text-muted-foreground text-xs">
                    {m['mentoring_dashboard.updated_at']({
                      time: new Date(person.computedAt).toLocaleString(),
                    })}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* 逐事表：3 个确认节点 */}
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>
                  {m['mentoring_dashboard.person_nodes_title']()}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        {m['mentoring_dashboard.col_node_plan']()}
                      </TableHead>
                      <TableHead>
                        {m['mentoring_dashboard.col_node_expected']()}
                      </TableHead>
                      <TableHead>
                        {m['mentoring_dashboard.col_node_completion']()}
                      </TableHead>
                      <TableHead>
                        {m['mentoring_dashboard.col_node_milestone']()}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {person.nodes.map((n) => (
                      <TableRow key={n.node}>
                        <TableCell className="font-medium">
                          {n.node}
                          <div className="text-muted-foreground text-xs font-normal">
                            {person.planType ?? '—'}
                          </div>
                        </TableCell>
                        <TableCell>{n.expected ?? '—'}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              n.state === 'passed'
                                ? 'secondary'
                                : n.state === 'confirmed'
                                  ? 'outline'
                                  : 'outline'
                            }
                          >
                            {nodeStateLabel(n.state)}
                          </Badge>
                          {n.passed && n.state !== 'passed' && (
                            <span className="text-muted-foreground ml-2 text-xs">
                              {n.passed}
                            </span>
                          )}
                          {n.confirmedAt && (
                            <div className="text-muted-foreground mt-1 text-xs">
                              {shortDate(n.confirmedAt)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>{milestoneLabel(n.state)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="text-muted-foreground mt-3 text-xs">
                  {m['mentoring_dashboard.person_nodes_note']()}
                </p>
              </CardContent>
            </Card>

            {/* 导师确认明细 */}
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>
                  {m['mentoring_dashboard.confirmations_title']()}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {person.nodeRatings && (
                  <p className="mb-3 text-sm">
                    <span className="text-muted-foreground">
                      {m['mentoring_dashboard.node_ratings']()}：
                    </span>
                    {person.nodeRatings}
                  </p>
                )}
                {person.confirmations.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {m['mentoring_dashboard.confirmations_empty']()}
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          {m['mentoring_dashboard.col_node_plan']()}
                        </TableHead>
                        <TableHead>
                          {m['mentoring_dashboard.col_node_completion']()}
                        </TableHead>
                        <TableHead>
                          {m['mentoring_dashboard.col_comments']()}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {person.confirmations.map((c, i) => (
                        <TableRow key={`${c.node ?? ''}-${i}`}>
                          <TableCell className="font-medium">
                            {c.node ?? '—'}
                            {c.timeNode && (
                              <div className="text-muted-foreground text-xs font-normal">
                                {c.timeNode}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            {c.passed ?? '—'}
                            {c.confirmedAt && (
                              <div className="text-muted-foreground mt-1 text-xs">
                                {shortDate(c.confirmedAt)}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            {[
                              c.comments.lead,
                              c.comments.keyAccount,
                              c.comments.exempt,
                            ]
                              .filter(Boolean)
                              .join('；') || '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            {/* 课程 */}
            <Card className="mt-6">
              <CardHeader>
                <CardTitle>
                  {m['mentoring_dashboard.courses_title']()}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-sm">
                  <span>
                    {m['mentoring_dashboard.courses_progress_records']()}：
                    {person.progressRecords}
                  </span>
                  <span>
                    {m['mentoring_dashboard.courses_quiz_attempts']()}：
                    {person.quizAttempts}
                  </span>
                  <span>
                    {m['mentoring_dashboard.courses_last_activity']()}：
                    {person.lastActivityAt
                      ? new Date(person.lastActivityAt).toLocaleString()
                      : '—'}
                  </span>
                </div>
                {person.courses.length === 0 ? (
                  <p className="text-muted-foreground mt-3 text-sm">
                    {m['mentoring_dashboard.courses_empty']()}
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>bid</TableHead>
                        <TableHead>
                          {m['mentoring_dashboard.col_status']()}
                        </TableHead>
                        <TableHead>
                          {m['mentoring_dashboard.col_completion']()}
                        </TableHead>
                        <TableHead>
                          {m['mentoring_dashboard.col_expected_date']()}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {person.courses.map((c) => (
                        <TableRow key={c.shifuBid}>
                          <TableCell className="font-mono text-xs">
                            {c.shifuBid}
                          </TableCell>
                          <TableCell>{c.status ?? '—'}</TableCell>
                          <TableCell>
                            {c.progressPct === null ? '—' : `${c.progressPct}%`}
                          </TableCell>
                          <TableCell>{shortDate(c.deadline)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        ) : (
          <Card className="mt-6">
            <CardContent className="text-muted-foreground py-10 text-center text-sm">
              {personQ.isFetching ? '…' : ''}
            </CardContent>
          </Card>
        )}
      </main>
      <Footer />
    </div>
  );
}
