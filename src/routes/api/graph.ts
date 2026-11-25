import { createFileRoute } from '@tanstack/react-router';
import { like } from 'drizzle-orm';

import { getAuth } from '@/core/auth';
import { db } from '@/core/db';
import { graphCourseLink, post } from '@/config/db/schema';
import { docSectionUrl, loadDocIndex } from '@/modules/ai-assistant/doc-index';
import { hasPermission } from '@/modules/rbac/service';
import { respData, respErr } from '@/lib/resp';

export interface GraphOverlayCourse {
  bid: string;
  slug: string;
  title: string;
  status: string;
}

export interface GraphOverlayLink {
  nodeId: string;
  courseBid: string;
  score: number;
}

/**
 * 按查看者过滤图谱叠加数据（纯函数，可单测）：
 * - 管理员：全部课程（含草稿／已排查）＋全部关联。
 * - 其他登录用户：只看已发布课程，关联也只保留指向已发布课的；
 *   草稿课的 bid／标题／状态一律不返回（不在页面藏，而在服务端就不给）。
 */
export function filterGraphOverlayForViewer(
  courses: GraphOverlayCourse[],
  links: GraphOverlayLink[],
  isAdmin: boolean
): { courses: GraphOverlayCourse[]; links: GraphOverlayLink[] } {
  if (isAdmin) return { courses, links };
  const published = courses.filter((c) => c.status === 'published');
  const publishedBids = new Set(published.map((c) => c.bid));
  return {
    courses: published,
    links: links.filter((l) => publishedBids.has(l.courseBid)),
  };
}

/**
 * GET /api/graph — 知识图谱实时叠加数据（活数据）。
 *
 * 页面静态读 src/content/graph/graph.json（骨架），再调本接口覆盖状态：
 * - courses：post 表实时 slug/title/status（已发布／草稿／已排查；不在表里
 *   即未入库）。图谱关联同步（主机 sync-graph-courses.py）把已发布＋草稿＋
 *   已排查课程都按关键词关联到节点；可见性在这里按管理员过滤，非管理员
 *   只返回已发布课及其关联（草稿不在服务端返回，页面也就不展示）。
 * - links：graph_course_link 表，定时同步写（静态 TREE 链接仍在 graph.json
 *   里，本接口只返回动态关联；页面合并两边去重后展示，课程总数不再是
 *   静态 9 门）
 * - docs：loadDocIndex() 实时 section 清单（有更新时页面上显示“有更新”）
 * 失败时调用方按构建时状态降级展示，不阻塞页面。
 */
async function GET({ request }: { request: Request }) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return respErr('Unauthorized');

  // 管理员判定只认字面量 admin.*（与 /api/graph/people 一致）；单个
  // admin.* 权限码不算数，判定失败时按非管理员处理，不抛错。
  const isAdmin = await hasPermission(session.user.id, 'admin.*').catch(
    () => false
  );

  const rows = await db()
    .select({
      slug: post.slug,
      title: post.title,
      status: post.status,
    })
    .from(post)
    .where(like(post.slug, 'course-%'));

  const allLinks = await db()
    .select({
      nodeId: graphCourseLink.nodeId,
      courseBid: graphCourseLink.courseBid,
      score: graphCourseLink.score,
    })
    .from(graphCourseLink);

  const sections = await loadDocIndex().catch(() => []);
  const published = rows.filter((r) => r.status === 'published');
  const { courses, links } = filterGraphOverlayForViewer(
    rows.map((r) => ({
      bid: r.slug.replace(/^course-/, ''),
      slug: r.slug,
      title: r.title ?? '',
      status: r.status,
    })),
    allLinks,
    isAdmin
  );
  return respData({
    isAdmin,
    courses,
    links,
    counts: {
      publishedCourses: published.length,
      linkedCourses: new Set(links.map((l) => l.courseBid)).size,
      linkTotal: links.length,
    },
    docs: sections.map((s) => ({
      docKey: s.docKey,
      docTitle: s.docTitle,
      sectionId: s.sectionId,
      sectionTitle: s.sectionTitle,
      url: docSectionUrl(s as any),
    })),
  });
}

export const Route = createFileRoute('/api/graph')({
  server: { handlers: { GET } },
});
