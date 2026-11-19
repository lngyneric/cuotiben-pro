// Wiki 操作时间线：只读聚合，不写库、不新增表。
// 数据源（全部按当前用户过滤）：
//   user_event（ai_assistant_query）、cuotiben_card、admin_execution
//   （posts_batch_status）、blog_html_file 按 user_id；
//   user_status_summary 按权限决定范围（admin 看全量，普通用户只看本人）。
// 不返回密码、token、密钥、问句原文、inputHash。
import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';

import { matchPermission } from '@/core/auth/rbac';
import { db } from '@/core/db';
import {
  adminExecution,
  blogHtmlFile,
  cuotibenCard,
  permission,
  role,
  rolePermission,
  user,
  userEvent,
  userRole,
  userStatusSummary,
  type AdminExecution,
  type BlogHtmlFile,
  type CuotibenCard,
  type UserEvent,
  type UserStatusSummary,
} from '@/config/db/schema';

export type TimelineCategory =
  | 'assistant'
  | 'card'
  | 'admin'
  | 'html'
  | 'mentor'
  | 'system';

export type TimelineEvent = {
  id: string;
  /** 毫秒时间戳 */
  at: number;
  category: TimelineCategory;
  title: string;
  detail?: string;
  href?: string;
};

export type TimelineTodos = {
  pendingConfirm: number;
  overdue: number;
  unresolvedIdentity: number;
  noCourseActivity: number;
};

export type WikiTimeline = {
  events: TimelineEvent[];
  todos: TimelineTodos;
};

/** 事件列表最多保留最近这么多条（防 user_event 长期增长把页面拖垮）。 */
const MAX_EVENTS = 100;

// ─── 小工具 ──────────────────────────────────────────────────────────────────

/** 解析 JSON，失败返回 fallback（脏数据不抛错）。 */
function safeJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** 跑一条只读查询，出错返回 fallback（不抛错）。drizzle 查询是 thenable，
 *  直接 .catch(() => []) 会丢掉行类型，所以用这个包一层保住类型。
 *  fallback 用 NoInfer：T 只从查询推断，不被 [] 带偏成 never。 */
async function safeQuery<T>(
  query: PromiseLike<T>,
  fallback: NoInfer<T>
): Promise<T> {
  try {
    return await query;
  } catch {
    return fallback;
  }
}

/** Date / ISO 字符串 / 毫秒数 → 毫秒时间戳；解析失败返回 null。 */
function toMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** 取文本第一个非空行（记事简述用）。 */
function firstLine(text: string): string {
  const line = (text || '').split('\n').find((l) => l.trim() !== '');
  return (line ?? '').trim();
}

/** 当前用户的权限码（与 rbac/service.ts 的 getUserPermissionCodes 同口径，
 *  但这里直接读 schema 表——模块之间不互相 import。 */
async function getUserPermissionCodes(userId: string): Promise<string[]> {
  const now = new Date();
  const roles = await safeQuery<{ roleId: string }[]>(
    db()
      .select({ roleId: userRole.roleId })
      .from(userRole)
      .innerJoin(role, eq(userRole.roleId, role.id))
      .where(
        and(
          eq(role.status, 'active'),
          eq(userRole.userId, userId),
          or(isNull(userRole.expiresAt), gt(userRole.expiresAt, now))
        )
      ),
    []
  );
  if (roles.length === 0) return [];
  const roleIds = roles.map((r) => r.roleId);
  const perms = await safeQuery<{ code: string }[]>(
    db()
      .select({ code: permission.code })
      .from(rolePermission)
      .innerJoin(permission, eq(rolePermission.permissionId, permission.id))
      .where(inArray(rolePermission.roleId, roleIds)),
    []
  );
  return [...new Set(perms.map((p) => p.code))];
}

/** 从 posts_batch_status 的 response 里取 updated 计数。
 *  存储格式是 {"status":200,"body":{"code":0,"data":{"updated":N}}}，
 *  兼容裸 {"updated":N} 与 {"data":{"updated":N}}。 */
function parseBatchUpdated(response: string | null): number | null {
  const parsed = safeJson<any>(response, null);
  if (!parsed || typeof parsed !== 'object') return null;
  const n =
    parsed?.body?.data?.updated ??
    parsed?.data?.updated ??
    parsed?.updated ??
    null;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

export async function getWikiTimeline(userId: string): Promise<WikiTimeline> {
  // 身份：wiki 用户行邮箱前缀小写 = 工号（与 recommend / chat 同口径）。
  const [me] = await safeQuery<{ email: string }[]>(
    db()
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1),
    []
  );
  const email = me?.email ?? '';
  const employeeNo = email.includes('@')
    ? email.split('@')[0].toLowerCase()
    : null;

  const codes = await getUserPermissionCodes(userId).catch(() => []);
  const isAdmin = matchPermission('admin.*', codes);

  const events: TimelineEvent[] = [];

  // ── AI 助手问答（user_event，只记模式/是否命中/课程数，不含问句） ──
  const assistantRows = await safeQuery<UserEvent[]>(
    db()
      .select()
      .from(userEvent)
      .where(
        and(
          eq(userEvent.userId, userId),
          eq(userEvent.kind, 'ai_assistant_query')
        )
      )
      .orderBy(desc(userEvent.createdAt)),
    []
  );
  for (const row of assistantRows) {
    const detail = safeJson<any>(row.detail, {});
    const found = detail?.found === true;
    const courses = typeof detail?.courses === 'number' ? detail.courses : 0;
    const at = toMs(row.createdAt);
    if (at === null) continue;
    events.push({
      id: `assistant:${row.id}`,
      at,
      category: 'assistant',
      title: found
        ? `问了 AI 学习助手，推荐了 ${courses} 门课`
        : '问了 AI 学习助手，未找到相关课程',
    });
  }

  // ── 记事卡片（cuotiben_card） ──
  // 卡片表只有 createdAt，没有“完成时间”列，所以完成只能显示当前状态，
  // 不能标出何时完成；事件时间一律用创建时间。
  const cardRows = await safeQuery<CuotibenCard[]>(
    db()
      .select()
      .from(cuotibenCard)
      .where(eq(cuotibenCard.userId, userId))
      .orderBy(desc(cuotibenCard.createdAt)),
    []
  );
  for (const row of cardRows) {
    const at = toMs(row.createdAt);
    if (at === null) continue;
    const summary = firstLine(row.question).slice(0, 60);
    events.push({
      id: `card:${row.id}`,
      at,
      category: 'card',
      title: summary ? `新建记事「${summary}」` : '新建记事',
      detail: row.mastered ? '已完成' : '待处理',
      href: `#note-${row.id}`,
    });
  }

  // ── 管理员批量改文章状态（admin_execution，只取成功的写操作） ──
  const adminRows = await safeQuery<AdminExecution[]>(
    db()
      .select()
      .from(adminExecution)
      .where(
        and(
          eq(adminExecution.userId, userId),
          eq(adminExecution.operation, 'posts_batch_status'),
          eq(adminExecution.status, 'completed')
        )
      )
      .orderBy(desc(adminExecution.createdAt)),
    []
  );
  for (const row of adminRows) {
    const at = toMs(row.createdAt);
    if (at === null) continue;
    const updated = parseBatchUpdated(row.response);
    events.push({
      id: `admin:${row.id}`,
      at,
      category: 'admin',
      title:
        updated === null
          ? '批量修改了文章状态'
          : `批量修改了 ${updated} 篇文章的状态`,
    });
  }

  // ── HTML 上传（blog_html_file） ──
  const htmlRows = await safeQuery<BlogHtmlFile[]>(
    db()
      .select()
      .from(blogHtmlFile)
      .where(eq(blogHtmlFile.uploaderId, userId))
      .orderBy(desc(blogHtmlFile.createdAt)),
    []
  );
  for (const row of htmlRows) {
    const at = toMs(row.createdAt);
    if (at === null) continue;
    events.push({
      id: `html:${row.key}`,
      at,
      category: 'html',
      title: row.title
        ? `上传了 HTML 文件「${row.title}」`
        : '上传了 HTML 文件',
      detail: row.category ? `分类：${row.category}` : undefined,
      href: `/api/blog/html/${encodeURIComponent(row.key)}`,
    });
  }

  // ── 学员状态汇总（user_status_summary） ──
  // admin 看全量；普通用户只看 employeeNo 等于自己的行（工号为空则看不到）。
  const allSummaryRows = await safeQuery<UserStatusSummary[]>(
    db()
      .select()
      .from(userStatusSummary)
      .orderBy(desc(userStatusSummary.computedAt)),
    []
  );
  const scopedRows =
    isAdmin || !employeeNo
      ? isAdmin
        ? allSummaryRows
        : []
      : allSummaryRows.filter((r) => r.employeeNo === employeeNo);

  // 待办：按行计数（每行是一条带教记录；一人可有两行，如谢艳芳）。
  const todos: TimelineTodos = {
    pendingConfirm: 0,
    overdue: 0,
    unresolvedIdentity: 0,
    noCourseActivity: 0,
  };
  for (const row of scopedRows) {
    const flags = safeJson<string[]>(row.flags, []);
    if (!Array.isArray(flags)) continue;
    if (flags.includes('pending_confirm')) todos.pendingConfirm++;
    if (flags.includes('overdue')) todos.overdue++;
    if (flags.includes('unresolved_identity')) todos.unresolvedIdentity++;
    if (flags.includes('no_course_activity')) todos.noCourseActivity++;
  }

  // 导师确认 / 评语：actual.confirmations 里 passed、confirmedAt 或任一
  // comment 非 null 的项。目前生产库里这类内容为空（仅官雨润 1 行有结构，
  // 且三项全为 null），代码按将来出现非 null 值来处理。
  for (const row of scopedRows) {
    const actual = safeJson<any>(row.actual, {});
    const confirmations = Array.isArray(actual?.confirmations)
      ? actual.confirmations
      : [];
    confirmations.forEach((c: any, i: number) => {
      if (!c || typeof c !== 'object') return;
      const comments = c.comments ?? {};
      const hasComment = ['lead', 'keyAccount', 'exempt'].some(
        (k) =>
          comments[k] !== null &&
          comments[k] !== undefined &&
          String(comments[k]).trim() !== ''
      );
      if (c.passed === null && c.confirmedAt === null && !hasComment) return;
      const at = toMs(c.confirmedAt) ?? toMs(row.computedAt);
      if (at === null) return;
      const node = String(c.node ?? '').trim();
      const detailParts: string[] = [];
      if (
        c.passed !== null &&
        c.passed !== undefined &&
        String(c.passed).trim() !== ''
      )
        detailParts.push(`通过：${c.passed}`);
      if (
        c.confirmedAt !== null &&
        c.confirmedAt !== undefined &&
        String(c.confirmedAt).trim() !== ''
      )
        detailParts.push(`确认于 ${c.confirmedAt}`);
      if (hasComment) {
        const firstComment = ['lead', 'keyAccount', 'exempt']
          .map((k) => comments[k])
          .find(
            (v) => v !== null && v !== undefined && String(v).trim() !== ''
          );
        if (firstComment !== undefined)
          detailParts.push(`评语：${String(firstComment).slice(0, 60)}`);
      }
      events.push({
        id: `mentor:${row.id}:${i}`,
        at,
        category: 'mentor',
        title: node
          ? `导师确认：${row.name} · ${node}`
          : `导师确认：${row.name}`,
        detail: detailParts.length ? detailParts.join('，') : undefined,
      });
    });
  }

  // 系统同步：全量取最大的 computed_at（全局同步心跳，不按用户过滤），
  // 标题里的条数是汇总表总行数。
  if (allSummaryRows.length > 0) {
    const latest = allSummaryRows[0];
    const at = toMs(latest?.computedAt);
    if (at !== null) {
      events.push({
        id: `system:${at}`,
        at,
        category: 'system',
        title: `系统同步学员状态，共 ${allSummaryRows.length} 条`,
      });
    }
  }

  // 统一按时间倒序；时间相同按 id 稳定排序。只保留最近 MAX_EVENTS 条。
  events.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));

  return { events: events.slice(0, MAX_EVENTS), todos };
}
