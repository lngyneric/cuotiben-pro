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

    // 提取标题和描述，用于博客卡片展示
    const titleMatch = content.match(/<title>([^<]*)<\/title>/i);
    const descMatch = content.match(
      /<meta\s+name="description"\s+content="([^"]*)"/i
    );
    const title = titleMatch?.[1]?.trim() || file.name.replace('.html', '');
    const description = descMatch?.[1]?.trim() || '';

    const key = `html/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    await bucket.put(key, content, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
      customMetadata: { title, description },
    });

    return respData({
      key,
      title,
      description,
      url: `/api/blog/html/${encodeURIComponent(key)}`,
    });
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
    const items = await Promise.all(
      (listed.objects || []).map(async (o: any) => {
        // 从 R2 head 获取自定义元数据（标题/描述）
        let title = o.key.replace('html/', '').replace('.html', '');
        let description = '';
        try {
          const head = await bucket.head(o.key);
          if (head?.customMetadata?.title) title = head.customMetadata.title;
          if (head?.customMetadata?.description)
            description = head.customMetadata.description;
        } catch {
          // 忽略，fallback 用文件名
        }
        return {
          key: o.key,
          title,
          description,
          size: o.size,
          uploaded: o.uploaded,
          url: `/api/blog/html/${encodeURIComponent(o.key)}`,
        };
      })
    );

    // 按上传时间倒序
    items.sort(
      (a, b) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime()
    );

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
