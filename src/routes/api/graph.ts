import { createFileRoute } from '@tanstack/react-router';
import { like } from 'drizzle-orm';

import { getAuth } from '@/core/auth';
import { db } from '@/core/db';
import { post } from '@/config/db/schema';
import { docSectionUrl, loadDocIndex } from '@/modules/ai-assistant/doc-index';
import { respData, respErr } from '@/lib/resp';

/**
 * GET /api/graph — 知识图谱实时叠加数据（活数据）。
 *
 * 页面静态读 src/content/graph/graph.json（骨架），再调本接口覆盖状态：
 * - courses：post 表实时 slug/title/status（已发布／草稿；不在表里即未入库）
 * - docs：loadDocIndex() 实时 section 清单（有更新时页面上显示“有更新”）
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

  const sections = await loadDocIndex().catch(() => []);
  return respData({
    courses: rows.map((r) => ({
      bid: r.slug.replace(/^course-/, ''),
      slug: r.slug,
      title: r.title ?? '',
      status: r.status,
    })),
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
