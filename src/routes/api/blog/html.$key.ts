import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { canViewBlogHtml, isBlogAdmin } from '@/modules/blog-html/service';
import {
  getBlogHtml,
  getBlogStorageBackend,
} from '@/modules/blog-html/storage';

// GET /api/blog/html/:key — 渲染已上传的 HTML。
//
// 行为按后端区分（内网版的关键改动）：
// - 本地后端（内网服务器）：`public` 可见范围的文件无需登录即可打开；
//   其余文件必须登录，未登录 401；`self` 可见范围的文档只对上传者本人
//   和管理员开放。内网站不再公开渲染（除非文件被显式设为共享公开）。
// - R2 后端（Cloudflare 线上站）：保持现有公开行为不变（可直接分享）。
async function GET({
  request,
  params,
}: {
  request: Request;
  params: { key: string };
}) {
  try {
    const key = decodeURIComponent(params.key);
    // 只允许 html/ 前缀，防止路径遍历
    if (!key.startsWith('html/')) {
      return new Response('Not found', { status: 404 });
    }

    const backend = getBlogStorageBackend();
    if (backend === 'local') {
      const got = await getBlogHtml(key);
      if (!got) return new Response('Not found', { status: 404 });
      // 共享公开的文件：无需登录即可打开。
      if (got.meta.visibility === 'public') {
        return renderHtml(got.content);
      }
      const auth = getAuth();
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session?.user) {
        return new Response('Unauthorized', { status: 401 });
      }
      const viewer = {
        userId: session.user.id,
        isAdmin: await isBlogAdmin(session.user.id),
      };
      if (!canViewBlogHtml(got.meta, viewer)) {
        return new Response('Not found', { status: 404 });
      }
      return renderHtml(got.content);
    }

    const got = await getBlogHtml(key);
    if (!got) return new Response('Not found', { status: 404 });
    return renderHtml(got.content);
  } catch (error: any) {
    return new Response('Error: ' + error.message, { status: 500 });
  }
}

function renderHtml(content: string): Response {
  // 用 sandbox iframe 隔离渲染，防止 XSS
  // 直接返回 HTML，浏览器会渲染
  return new Response(content, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // 安全头：不允许被嵌入其他网站（除非同源）
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "frame-ancestors 'self'",
    },
  });
}

export const Route = createFileRoute('/api/blog/html/$key')({
  server: {
    handlers: { GET },
  },
});
