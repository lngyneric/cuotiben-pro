import { createFileRoute } from '@tanstack/react-router';
import { desc, eq, like, or } from 'drizzle-orm';

import { getAuth } from '@/core/auth';
import { db } from '@/core/db';
import {
  graphCourseLink,
  post,
  rolePersonMap,
  userStatusSummary,
} from '@/config/db/schema';
import { hasPermission } from '@/modules/rbac/service';
import { respData, respErr } from '@/lib/resp';
import graphData from '@/content/graph/graph.json';
import treeData from '@/content/graph/ivd-tree.json';

const GRAPH = graphData as unknown as {
  nodes: {
    id: string;
    label: string;
    class: string;
    data: Record<string, unknown>;
  }[];
  edges: { source: string; property: string; target: string }[];
};

const TREE = treeData as unknown as {
  learning_paths_detail: Record<
    string,
    { name: string; stages: { stage: number; name: string; nodes: string[] }[] }
  >;
};

// 带教计划类型 → 带教阶段路径（learning_paths_detail 的三条路径）。
function pathKeyForPlanType(planType: string | null | undefined): string {
  const t = (planType ?? '').trim();
  if (t === '销售' || t === '大客户' || t === '产品经理') return 'sales';
  return 'technical';
}

interface PersonRef {
  name: string;
  wecomUserId?: string | null;
  employeeNo?: string | null;
  type?: string | null;
}

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * GET /api/graph/people — 人员轴：导师 → 学员 → 旗标 → 补缺推荐。
 *
 * 数据源：role_person_map（企微智能表「角色人员对应表」定时同步，校验对应
 * 关系以该表为准）＋ user_status_summary（学员状态快照）。
 * 权限：管理员看全部导师；导师（role=导师/两者都是，按 wiki 邮箱前缀工号
 * 匹配）只看自己的学员；其他人 403。
 * 补缺推荐是确定性规则，不调 LLM：待确认→不推课；零跑课→推本路径第 1 阶段
 * 首门已发布课；有跑课→按阶段顺序推首门未学过的已发布课；都学完→不推。
 */
async function GET({ request }: { request: Request }) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return respErr('Unauthorized');

  const isAdmin = await hasPermission(session.user.id, 'admin.*').catch(
    () => false
  );
  const employeeNo = session.user.email?.split('@')[0]?.toLowerCase() ?? '';

  // 静态课程链接：graph.json nodeHasCourse 边（node:<slug> → course:<bid>）。
  const nodeCourses = new Map<string, string[]>();
  for (const e of GRAPH.edges) {
    if (e.property !== 'nodeHasCourse') continue;
    const list = nodeCourses.get(e.source) ?? [];
    if (e.target.startsWith('course:'))
      list.push(e.target.slice('course:'.length));
    nodeCourses.set(e.source, list);
  }
  // 动态关联：graph_course_link 表（定时同步），按 score 降序排在静态之后。
  const dynLinks = await db()
    .select({
      nodeId: graphCourseLink.nodeId,
      courseBid: graphCourseLink.courseBid,
      score: graphCourseLink.score,
    })
    .from(graphCourseLink)
    .orderBy(desc(graphCourseLink.score));
  for (const l of dynLinks) {
    const list = nodeCourses.get(l.nodeId) ?? [];
    if (!list.includes(l.courseBid)) list.push(l.courseBid);
    nodeCourses.set(l.nodeId, list);
  }
  // 已发布课程（bid → {slug, title}）。
  const published = new Map<string, { slug: string; title: string }>();
  for (const r of await db()
    .select({ slug: post.slug, title: post.title, status: post.status })
    .from(post)
    .where(like(post.slug, 'course-%'))) {
    if (r.status !== 'published') continue;
    published.set(r.slug.replace(/^course-/, ''), {
      slug: r.slug,
      title: r.title ?? '',
    });
  }

  // 全部导师行（role=导师/两者都是）。
  const mentorRows = await db()
    .select()
    .from(rolePersonMap)
    .where(
      or(eq(rolePersonMap.role, '导师'), eq(rolePersonMap.role, '两者都是'))
    );

  let scope: 'admin' | 'mentor';
  let mentors: typeof mentorRows;
  if (isAdmin) {
    scope = 'admin';
    mentors = mentorRows;
  } else {
    scope = 'mentor';
    mentors = mentorRows.filter(
      (m) => (m.employeeNo ?? '').toLowerCase() === employeeNo
    );
    if (mentors.length === 0) return respErr('Forbidden', { status: 403 });
  }

  // 学员状态：按工号（不区分大小写）优先，工号为空时按姓名。
  const statusRows = await db().select().from(userStatusSummary);
  const byEmployee = new Map<string, (typeof statusRows)[number]>();
  const byName = new Map<string, (typeof statusRows)[number]>();
  for (const r of statusRows) {
    if (r.employeeNo && !byEmployee.has(r.employeeNo.toLowerCase()))
      byEmployee.set(r.employeeNo.toLowerCase(), r);
    if (r.name && !byName.has(r.name)) byName.set(r.name, r);
  }

  function recommendFor(
    planType: string | null | undefined,
    takenBids: Set<string>,
    flags: string[]
  ): {
    bid: string;
    title: string;
    slug: string;
    reason: string;
  } | null {
    if (flags.includes('pending_confirm')) return null; // 带教已完成，待导师确认：不推课
    const path = TREE.learning_paths_detail[pathKeyForPlanType(planType)];
    if (!path) return null;
    const stages = [...path.stages].sort((a, b) => a.stage - b.stage);
    // 零跑课：只看第 1 阶段；有跑课：按阶段顺序找首门未学过的。
    const searchStages = flags.includes('no_course_activity')
      ? stages.slice(0, 1)
      : stages;
    for (const st of searchStages) {
      for (const slug of st.nodes) {
        const bids = nodeCourses.get(`node:${slug}`) ?? [];
        for (const bid of bids) {
          const pub = published.get(bid);
          if (!pub || takenBids.has(bid)) continue;
          return {
            bid,
            title: pub.title,
            slug: pub.slug,
            reason: flags.includes('no_course_activity')
              ? 'no_course_activity'
              : 'next_stage',
          };
        }
      }
    }
    return null;
  }

  const out = [];
  for (const m of mentors) {
    const mentees = safeJson<PersonRef[]>(m.mentees, []);
    const menteeOut = [];
    for (const person of mentees) {
      const st =
        (person.employeeNo
          ? byEmployee.get(person.employeeNo.toLowerCase())
          : undefined) ?? byName.get(person.name);
      const actual = safeJson<Record<string, unknown>>(st?.actual, {});
      const flags = safeJson<string[]>(st?.flags, []);
      const courses = (actual.courses as { shifu_bid?: string }[]) ?? [];
      const taken = new Set(
        courses.map((c) => c.shifu_bid).filter((b): b is string => !!b)
      );
      const rec = st ? recommendFor(st.planType, taken, flags) : null;
      const reason = !st
        ? 'no_record'
        : flags.includes('pending_confirm')
          ? 'pending_confirm'
          : rec
            ? rec.reason
            : 'all_done';
      menteeOut.push({
        name: person.name,
        employeeNo: person.employeeNo ?? st?.employeeNo ?? null,
        planType: st?.planType ?? null,
        status: (actual.status as string | undefined) ?? null,
        flags,
        scores: (actual.scores as Record<string, number> | undefined) ?? null,
        coursesTaken: taken.size,
        lastActivityAt:
          (actual.lastActivityAt as string | null | undefined) ?? null,
        recommendation: rec,
        recommendReason: reason,
      });
    }
    out.push({
      id: m.id,
      name: m.name,
      employeeNo: m.employeeNo ?? null,
      mentorTypes: safeJson<string[]>(m.mentorTypes, []),
      mentees: menteeOut,
    });
  }

  return respData({ scope, mentors: out });
}

export const Route = createFileRoute('/api/graph/people')({
  server: { handlers: { GET } },
});
