// 学分制带教 Dashboard：数据层（只读）。
//
// 数据源：blog 库 user_status_summary（每小时同步全量替换的派生快照，
// 同一行含计划列与 actual JSON）＋ role_person_map（角色人员对应表，
// 导师—学员对应关系以该表为准，不按姓名匹配）。
//
// 权限：scope 由 API 路由算好传入（本模块不读会话、不判权限）。
//   - admin：全部行；可预览 hr / mentor 视角（mentor 视角须指定一位导师）。
//   - mentor：只看自己名下学员（按 role_person_map 的 mentees 列表，
//     工号优先、工号为空时按姓名；导师本人也可用自己的工号看自己的行）。
//   - self（学员）：只看自己的行；总表不对学员开放。
// HR 在 wiki 里目前没有独立角色：hr 视角是展示形态（全部行＋HR 跟进列），
// 仅管理员可切换预览；以后有了 HR 角色，授予 admin.mentoring_dashboard.read
// 即可按 admin 范围走 hr 视角。
//
// 不改写任何表；逾期只取同步算好的 flags（是否逾期字段或预计日期分支），
// 本模块不重算逾期。

import { eq, or } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  rolePersonMap,
  userStatusSummary,
  type RolePersonMap,
  type UserStatusSummary,
} from '@/config/db/schema';

/** Dashboard 管理员权限码：管理员范围认这一个 code（init-rbac 显式授予 admin 角色）。 */
export const MENTORING_DASHBOARD_PERMISSION = 'admin.mentoring_dashboard.read';

export type DashboardView = 'admin' | 'hr' | 'mentor';

export interface MentorRef {
  name: string;
  wecomUserId?: string | null;
  employeeNo?: string | null;
}

export type DashboardScope =
  | { kind: 'admin' }
  | {
      kind: 'mentor';
      mentorId: string;
      mentorName: string;
      /** 导师本人工号（role_person_map 行上的值；纯导师无工号时为空）。 */
      employeeNo: string | null;
      mentees: MentorRef[];
    }
  | { kind: 'self'; employeeNo: string };

export interface PlanNode {
  node: string;
  expected: string | null;
}

/** 节点完成态：passed 通过 / confirmed 已确认未通过 / pending 待确认。 */
export type NodeState = 'passed' | 'confirmed' | 'pending';

export interface NodeCompletion {
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

export interface Confirmation {
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

export interface Scores {
  process: number | null;
  gpa: number | null;
  elearn: number | null;
}

export interface CourseProgress {
  shifuBid: string;
  status: string | null;
  progressPct: number | null;
  deadline: string | null;
}

export interface MentoringRow {
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
  scores: Scores | null;
  flags: string[];
  /** 已通过节点数 / 全部节点数（完成度 x/y 的分子分母）。 */
  completedNodes: number;
  totalNodes: number;
  coursesCount: number;
  progressRecords: number;
  quizAttempts: number;
  lastActivityAt: string | null;
  computedAt: string | null;
}

export interface MentoringPerson extends MentoringRow {
  nodes: NodeCompletion[];
  confirmations: Confirmation[];
  nodeRatings: string | null;
  courses: CourseProgress[];
}

export interface DashboardSummary {
  total: number;
  byStatus: Record<string, number>;
  byPlanType: Record<string, number>;
  overdue: number;
  pendingConfirm: number;
  noCourseActivity: number;
  noWikiAccount: number;
}

export interface MentorOption {
  id: string;
  name: string;
  employeeNo: string | null;
  menteeCount: number;
}

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** plan JSON：{nodes: [{node, expected}]}；expected 在同步里恒为 null。 */
export function parsePlanNodes(planRaw: string | null): PlanNode[] {
  const plan = safeJson<Record<string, unknown>>(planRaw, {});
  const nodes = Array.isArray(plan.nodes) ? plan.nodes : [];
  return nodes
    .map((n) => {
      const o = (n ?? {}) as Record<string, unknown>;
      return { node: asString(o.node) ?? '', expected: asString(o.expected) };
    })
    .filter((n) => n.node !== '');
}

/** actual.confirmations：[{node, timeNode, passed, confirmedAt, comments}]。 */
export function parseConfirmations(actualRaw: string | null): Confirmation[] {
  const actual = safeJson<Record<string, unknown>>(actualRaw, {});
  const list = Array.isArray(actual.confirmations) ? actual.confirmations : [];
  return list.map((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const comments = (o.comments ?? {}) as Record<string, unknown>;
    return {
      node: asString(o.node),
      timeNode: asString(o.timeNode),
      passed: asString(o.passed),
      confirmedAt: asString(o.confirmedAt),
      comments: {
        lead: asString(comments.lead),
        keyAccount: asString(comments.keyAccount),
        exempt: asString(comments.exempt),
      },
    };
  });
}

/** 确认的“通过”字段判读：含“通过”且不含“不通过/未通过”算通过；非空算已确认。 */
export function nodeStateFor(passed: string | null): NodeState {
  if (!passed) return 'pending';
  if (passed.includes('不通过') || passed.includes('未通过'))
    return 'confirmed';
  if (passed.includes('通过')) return 'passed';
  return 'confirmed';
}

export function buildNodeCompletions(
  nodes: PlanNode[],
  confirmations: Confirmation[]
): NodeCompletion[] {
  return nodes.map((n) => {
    const conf = confirmations.find((c) => c.node === n.node);
    const passed = conf?.passed ?? null;
    return {
      node: n.node,
      expected: n.expected,
      state: conf ? nodeStateFor(passed) : 'pending',
      passed,
      confirmedAt: conf?.confirmedAt ?? null,
      comments: conf?.comments ?? {
        lead: null,
        keyAccount: null,
        exempt: null,
      },
    };
  });
}

function parseScores(actual: Record<string, unknown>): Scores | null {
  const s = actual.scores;
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  return {
    process: asNumber(o.process),
    gpa: asNumber(o.gpa),
    elearn: asNumber(o.elearn),
  };
}

function parseCourses(actual: Record<string, unknown>): CourseProgress[] {
  const list = Array.isArray(actual.courses) ? actual.courses : [];
  return list.map((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    return {
      shifuBid: asString(o.shifu_bid) ?? '',
      status: asString(o.status),
      progressPct: asNumber(o.progress_pct),
      deadline: asString(o.deadline),
    };
  });
}

function toMentoringRow(row: UserStatusSummary): MentoringRow {
  const actual = safeJson<Record<string, unknown>>(row.actual, {});
  const flags = safeJson<string[]>(row.flags, []).filter(
    (f): f is string => typeof f === 'string'
  );
  const nodes = parsePlanNodes(row.plan);
  const confirmations = parseConfirmations(row.actual);
  const completions = buildNodeCompletions(nodes, confirmations);
  const courses = parseCourses(actual);
  return {
    id: row.id,
    name: row.name,
    employeeNo: row.employeeNo,
    department: row.department,
    positionName: row.positionName,
    mentorLeadName: row.mentorLeadName,
    planType: row.planType,
    planStartDate: row.planStartDate,
    planEndDate: row.planEndDate,
    expectedDate: row.expectedDate,
    status: asString(actual.status),
    result: asString(actual.result),
    scores: parseScores(actual),
    flags,
    completedNodes: completions.filter((c) => c.state === 'passed').length,
    totalNodes: nodes.length,
    coursesCount: courses.length,
    progressRecords: asNumber(actual.progressRecords) ?? 0,
    quizAttempts: asNumber(actual.quizAttempts) ?? 0,
    lastActivityAt: asString(actual.lastActivityAt),
    computedAt: row.computedAt ? new Date(row.computedAt).toISOString() : null,
  };
}

function toMentoringPerson(row: UserStatusSummary): MentoringPerson {
  const base = toMentoringRow(row);
  const actual = safeJson<Record<string, unknown>>(row.actual, {});
  const nodes = parsePlanNodes(row.plan);
  const confirmations = parseConfirmations(row.actual);
  return {
    ...base,
    nodes: buildNodeCompletions(nodes, confirmations),
    confirmations,
    nodeRatings: asString(actual.nodeRatings),
    courses: parseCourses(actual),
  };
}

export function summarizeRows(rows: MentoringRow[]): DashboardSummary {
  const byStatus: Record<string, number> = {};
  const byPlanType: Record<string, number> = {};
  let overdue = 0;
  let pendingConfirm = 0;
  let noCourseActivity = 0;
  let noWikiAccount = 0;
  for (const r of rows) {
    const s = r.status ?? '—';
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    const t = r.planType ?? '—';
    byPlanType[t] = (byPlanType[t] ?? 0) + 1;
    if (r.flags.includes('overdue')) overdue += 1;
    if (r.flags.includes('pending_confirm')) pendingConfirm += 1;
    if (r.flags.includes('no_course_activity')) noCourseActivity += 1;
    if (r.flags.includes('no_wiki_account')) noWikiAccount += 1;
  }
  return {
    total: rows.length,
    byStatus,
    byPlanType,
    overdue,
    pendingConfirm,
    noCourseActivity,
    noWikiAccount,
  };
}

/**
 * HR 跟进列：只从已有 flags 派生（返回 flag code，页面再译成文案），不编造跟进记录。
 * 顺序即展示顺序：逾期 → 待确认 → 身份 → 跑课 → wiki 账号。
 */
export function hrFollowUpItems(row: MentoringRow): string[] {
  const order = [
    'overdue',
    'pending_confirm',
    'unresolved_identity',
    'no_course_activity',
    'no_wiki_account',
  ];
  return order.filter((f) => row.flags.includes(f));
}

function parseMentees(raw: string | null): MentorRef[] {
  const list = safeJson<unknown[]>(raw, []);
  return list
    .map((m) => {
      const o = (m ?? {}) as Record<string, unknown>;
      return {
        name: asString(o.name) ?? '',
        wecomUserId: asString(o.wecomUserId),
        employeeNo: asString(o.employeeNo),
      };
    })
    .filter((m) => m.name !== '');
}

/** 学员行是否属于某位导师的 mentees：工号优先，工号为空时按姓名（与图谱人员轴一致）。 */
export function menteeMatchesRow(
  mentee: MentorRef,
  row: UserStatusSummary
): boolean {
  if (
    mentee.employeeNo &&
    row.employeeNo &&
    mentee.employeeNo.toLowerCase() === row.employeeNo.toLowerCase()
  )
    return true;
  if (!mentee.employeeNo && mentee.name && row.name === mentee.name)
    return true;
  return false;
}

/**
 * 解析调用方范围（路由已算好 isAdmin、employeeNo）。
 * 管理员：全部；导师：role_person_map 里 role=导师/两者都是且工号匹配的行
 * （55 名纯导师无工号，无法按邮箱匹配，不猜姓名）；学员：自己有行才给 self；
 * 其他人：null（路由回 403）。
 */
export async function resolveDashboardScope(params: {
  isAdmin: boolean;
  employeeNo: string;
}): Promise<DashboardScope | null> {
  if (params.isAdmin) return { kind: 'admin' };
  const emp = (params.employeeNo ?? '').toLowerCase();
  if (emp) {
    const mentorRows = await db()
      .select()
      .from(rolePersonMap)
      .where(
        or(eq(rolePersonMap.role, '导师'), eq(rolePersonMap.role, '两者都是'))
      );
    const mine = mentorRows.find(
      (m: RolePersonMap) => (m.employeeNo ?? '').toLowerCase() === emp
    );
    if (mine) {
      return {
        kind: 'mentor',
        mentorId: mine.id,
        mentorName: mine.name,
        employeeNo: mine.employeeNo,
        mentees: parseMentees(mine.mentees),
      };
    }
    const own = await db()
      .select({ id: userStatusSummary.id })
      .from(userStatusSummary)
      .where(eq(userStatusSummary.employeeNo, params.employeeNo))
      .limit(1);
    if (own.length > 0) return { kind: 'self', employeeNo: params.employeeNo };
  }
  return null;
}

function mentorOptions(
  mentors: RolePersonMap[],
  statusRows: UserStatusSummary[]
): MentorOption[] {
  return mentors.map((m) => {
    const mentees = parseMentees(m.mentees);
    const count = statusRows.filter((r) =>
      mentees.some((x) => menteeMatchesRow(x, r))
    ).length;
    return {
      id: m.id,
      name: m.name,
      employeeNo: m.employeeNo,
      menteeCount: count,
    };
  });
}

export type ListDashboardResult =
  | {
      view: DashboardView;
      scope: 'admin' | 'mentor';
      rows: MentoringRow[];
      summary: DashboardSummary;
      mentors: MentorOption[];
      computedAt: string | null;
    }
  | { error: 'mentor_not_found' | 'forbidden' };

/** 全部行的最新 computedAt（同步时间，全行一致；空行时为 null）。 */
function latestComputedAt(rows: MentoringRow[]): string | null {
  return (
    rows
      .map((r) => r.computedAt)
      .filter((x): x is string => !!x)
      .sort()
      .at(-1) ?? null
  );
}

/**
 * 总表数据：按 scope＋view 取行。行数少（同步上限 500），全量取回后在
 * JS 里过滤、汇总；筛选与分页在前端做。
 */
export async function listDashboardRows(
  scope: DashboardScope,
  view: DashboardView,
  mentorId?: string | null
): Promise<ListDashboardResult> {
  if (scope.kind === 'self') return { error: 'forbidden' };
  const effectiveView: DashboardView =
    scope.kind === 'mentor' ? 'mentor' : view;
  const statusRows = await db().select().from(userStatusSummary);
  const mentorRows = await db()
    .select()
    .from(rolePersonMap)
    .where(
      or(eq(rolePersonMap.role, '导师'), eq(rolePersonMap.role, '两者都是'))
    );

  let rows: UserStatusSummary[];
  let mentors: MentorOption[];
  if (scope.kind === 'admin') {
    mentors = mentorOptions(mentorRows, statusRows);
    if (effectiveView === 'mentor') {
      if (!mentorId) {
        // 未选导师：返回空行＋导师列表，供页面渲染选择器；不报错。
        // 若报 mentor_required，前端查询拿不到数据，isAdminScope 为
        // false 会导致视角切换器与选择器一起消失、页面只剩提示
        // （2026-11-22 实测）。汇总按空行算（页面未选导师时不展示
        // 汇总卡片），computedAt 取全部行的最新值。
        return {
          view: 'mentor',
          scope: 'admin',
          rows: [],
          summary: summarizeRows([]),
          mentors,
          computedAt: latestComputedAt(statusRows.map(toMentoringRow)),
        };
      }
      const mentor = mentorRows.find((m: RolePersonMap) => m.id === mentorId);
      if (!mentor) return { error: 'mentor_not_found' };
      const mentees = parseMentees(mentor.mentees);
      rows = statusRows.filter((r: UserStatusSummary) =>
        mentees.some((x) => menteeMatchesRow(x, r))
      );
    } else {
      rows = statusRows;
    }
  } else {
    mentors = mentorOptions(
      mentorRows.filter((m: RolePersonMap) => m.id === scope.mentorId),
      statusRows
    );
    rows = statusRows.filter((r: UserStatusSummary) =>
      scope.mentees.some((x) => menteeMatchesRow(x, r))
    );
  }

  const shaped = rows.map(toMentoringRow);
  return {
    view: effectiveView,
    scope: scope.kind,
    rows: shaped,
    summary: summarizeRows(shaped),
    mentors,
    computedAt: latestComputedAt(shaped),
  };
}

export type GetDashboardPersonResult =
  | { person: MentoringPerson }
  | { error: 'not_found' | 'forbidden' };

/** 个人 Dashboard：一行（一个带教记录）。id 可带或不带 `record:` 前缀。 */
export async function getDashboardPerson(
  scope: DashboardScope,
  recordId: string
): Promise<GetDashboardPersonResult> {
  const id = recordId.startsWith('record:') ? recordId : `record:${recordId}`;
  const [row] = await db()
    .select()
    .from(userStatusSummary)
    .where(eq(userStatusSummary.id, id))
    .limit(1);
  if (!row) return { error: 'not_found' };
  if (scope.kind === 'admin') return { person: toMentoringPerson(row) };
  if (scope.kind === 'self') {
    const emp = scope.employeeNo.toLowerCase();
    if (row.employeeNo && row.employeeNo.toLowerCase() === emp)
      return { person: toMentoringPerson(row) };
    return { error: 'forbidden' };
  }
  const ownEmp = scope.mentees.some((x) => menteeMatchesRow(x, row));
  // 导师本人同时是学员时，按自己的工号可看自己的行（不按姓名猜）。
  const selfRow =
    !!scope.employeeNo &&
    !!row.employeeNo &&
    row.employeeNo.toLowerCase() === scope.employeeNo.toLowerCase();
  if (ownEmp || selfRow) return { person: toMentoringPerson(row) };
  return { error: 'forbidden' };
}
