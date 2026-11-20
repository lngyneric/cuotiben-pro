import { createFileRoute } from '@tanstack/react-router';
import { like } from 'drizzle-orm';

import { getAuth } from '@/core/auth';
import { db } from '@/core/db';
import { growthCourseLink, post } from '@/config/db/schema';
import { respData, respErr } from '@/lib/resp';

/**
 * GET /api/growth — 成长路径实时叠加数据（活数据）。
 *
 * 页面静态读 src/content/growth/growth.json（骨架＋ 8 门静态 ai-shifu
 * 课程），再调本接口覆盖：
 * - courses：post 表实时 slug/title/status（已发布／草稿；不在表里即未入库）
 * - links：growth_course_link 表，定时同步把 blog 已发布视频课按标题
 *   匹配到节点（sync-growth-courses.py，标题 2 字 gram 打分）。
 * 失败时调用方按构建时状态降级展示，不阻塞页面。
 */
async function GET({ request }: { request: Request }) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return respErr('Unauthorized');

  const rows = await db()
    .select({
      slug: post.slug,
      title: post.title,
      status: post.status,
    })
    .from(post)
    .where(like(post.slug, 'course-%'));

  const links = await db()
    .select({
      nodeId: growthCourseLink.nodeId,
      courseBid: growthCourseLink.courseBid,
      score: growthCourseLink.score,
    })
    .from(growthCourseLink);

  return respData({
    courses: rows.map((r) => ({
      bid: r.slug.replace(/^course-/, ''),
      slug: r.slug,
      title: r.title ?? '',
      status: r.status,
    })),
    links,
  });
}

export const Route = createFileRoute('/api/growth')({
  server: { handlers: { GET } },
});
