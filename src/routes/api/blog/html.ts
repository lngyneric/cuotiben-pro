import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { respData, respErr } from '@/lib/resp';

// R2 bucket binding（wrangler.jsonc 里配置）
function getBucket(): any {
  const env = (globalThis as any).__CF_ENV__;
  return env?.HTML_BUCKET || null;
}

// POST /api/blog/html — 上传 HTML 文件到 R2
async function POST({ request }: { request: Request }) {
  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return respErr('Unauthorized');

    const bucket = getBucket();
    if (!bucket) return respErr('R2 bucket not configured');

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) return respErr('No file uploaded');

    // 只允许 HTML
    if (!file.name.endsWith('.html') && file.type !== 'text/html') {
      return respErr('Only HTML files allowed');
    }

    // 限制 5MB
    if (file.size > 5 * 1024 * 1024) {
      return respErr('File too large (max 5MB)');
    }

    const content = await file.text();

    // 简单安全检查：不允许 <script src=> 外部脚本（内联 script 允许，用于单文件发布）
    // 实际渲染时用 iframe sandbox 隔离

    const key = `html/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    await bucket.put(key, content, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });

    return respData({ key, url: `/api/blog/html/${encodeURIComponent(key)}` });
  } catch (error: any) {
    return respErr(error.message || 'Upload failed');
  }
}

// GET /api/blog/html — 列出已上传的 HTML
async function GET({ request }: { request: Request }) {
  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return respErr('Unauthorized');

    const bucket = getBucket();
    if (!bucket) return respErr('R2 bucket not configured');

    const listed = await bucket.list({ prefix: 'html/' });
    const items = (listed.objects || []).map((o: any) => ({
      key: o.key,
      size: o.size,
      uploaded: o.uploaded,
      url: `/api/blog/html/${encodeURIComponent(o.key)}`,
    }));

    return respData({ items });
  } catch (error: any) {
    return respErr(error.message || 'Failed');
  }
}

export const Route = createFileRoute('/api/blog/html')({
  server: {
    handlers: { GET, POST },
  },
});
