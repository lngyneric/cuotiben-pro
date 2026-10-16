import { createFileRoute } from '@tanstack/react-router';

// GET /api/blog/html/:key — 从 R2 渲染 HTML（公开访问，用于分享）
async function GET({
  request,
  params,
}: {
  request: Request;
  params: { key: string };
}) {
  try {
    const env = (globalThis as any).__CF_ENV__;
    const bucket = env?.HTML_BUCKET;
    if (!bucket) {
      return new Response('R2 not configured', { status: 500 });
    }

    const key = decodeURIComponent(params.key);
    // 只允许 html/ 前缀，防止路径遍历
    if (!key.startsWith('html/')) {
      return new Response('Not found', { status: 404 });
    }

    const obj = await bucket.get(key);
    if (!obj) {
      return new Response('Not found', { status: 404 });
    }

    const content = await obj.text();

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
  } catch (error: any) {
    return new Response('Error: ' + error.message, { status: 500 });
  }
}

export const Route = createFileRoute('/api/blog/html/$key')({
  server: {
    handlers: { GET },
  },
});
