import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import {
  canManageBlogHtml,
  canViewBlogHtml,
  isBlogAdmin,
  sanitizeBlogHtml,
  type BlogViewer,
} from '@/modules/blog-html/service';
import {
  deleteBlogHtml,
  getBlogHtml,
  listBlogHtml,
  putBlogHtml,
  updateBlogHtmlCategory,
  type BlogHtmlVisibility,
} from '@/modules/blog-html/storage';
import { respData, respErr } from '@/lib/resp';

// 已知分类（与 docs/blog-html-spec.md 对齐）
export const BLOG_CATEGORIES = ['G8学习', '错题解析', '工具', '未分类'];

// 按标题/摘要/正文关键词自动打标
function autoCategorize(
  title: string,
  description: string,
  content: string
): string {
  const text = `${title} ${description} ${content.slice(0, 3000)}`;
  const rules: [string, RegExp][] = [
    ['错题解析', /错题|错因| mistake|error.notebook|cuotiben/i],
    ['G8学习', /G8|学习计划|作业|study.plan|homework|ManageBac/i],
    ['工具', /工具|tool|使用说明|教程|guide/i],
  ];
  for (const [cat, re] of rules) {
    if (re.test(text)) return cat;
  }
  return '未分类';
}

async function requireViewer(request: Request): Promise<{
  user: any;
  viewer: BlogViewer;
} | null> {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return null;
  return {
    user: session.user,
    viewer: {
      userId: session.user.id,
      isAdmin: await isBlogAdmin(session.user.id),
    },
  };
}

function employeeNoOf(user: any): string {
  // AAD users are keyed by the synthetic email {employeeNo}@sysmex.internal.
  const email = String(user?.email || '');
  return email.endsWith('@sysmex.internal')
    ? email.slice(0, -'@sysmex.internal'.length)
    : '';
}

// POST /api/blog/html — 上传 HTML 文件（R2 或本地磁盘，见 storage.ts）
async function POST({ request }: { request: Request }) {
  try {
    const authed = await requireViewer(request);
    if (!authed) return respErr('Unauthorized', { status: 401 });

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

    const rawContent = await file.text();
    // 服务端消毒：去掉 <script>/<iframe>/on* 事件/javascript: 链接等
    // （见 src/modules/blog-html/service.ts；渲染时仍有 iframe sandbox）。
    const content = sanitizeBlogHtml(rawContent);

    // 提取标题和描述，用于博客卡片展示
    const titleMatch = content.match(/<title>([^<]*)<\/title>/i);
    const descMatch = content.match(
      /<meta\s+name="description"\s+content="([^"]*)"/i
    );
    const title = titleMatch?.[1]?.trim() || file.name.replace('.html', '');
    const description = descMatch?.[1]?.trim() || '';

    // 分类：优先用表单提交的 category，否则按内容自动打标
    const manualCategory = (formData.get('category') as string)?.trim();
    const category =
      manualCategory || autoCategorize(title, description, content);

    // 可见范围：all（全体已注册可见，默认）或 self（仅自己和管理员可见）
    const visibilityParam = (formData.get('visibility') as string)?.trim();
    const visibility: BlogHtmlVisibility =
      visibilityParam === 'self' ? 'self' : 'all';

    const key = `html/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const item = await putBlogHtml(key, content, {
      title,
      description,
      category,
      visibility,
      uploaderId: authed.user.id,
      uploaderEmployeeNo: employeeNoOf(authed.user),
    });

    return respData(item);
  } catch (error: any) {
    return respErr(error.message || 'Upload failed');
  }
}

// GET /api/blog/html — 列出已上传的 HTML（服务端按会话过滤可见范围）
async function GET({ request }: { request: Request }) {
  try {
    const authed = await requireViewer(request);
    if (!authed) return respErr('Unauthorized', { status: 401 });

    const items = await listBlogHtml();
    const visible = items.filter((item) =>
      canViewBlogHtml(item, authed.viewer)
    );
    return respData({ items: visible });
  } catch (error: any) {
    return respErr(error.message || 'Failed');
  }
}

export const Route = createFileRoute('/api/blog/html')({
  server: {
    handlers: { GET, POST, DELETE, PATCH },
  },
});

// PATCH /api/blog/html — 修改分类（仅上传者本人或管理员）
async function PATCH({ request }: { request: Request }) {
  try {
    const authed = await requireViewer(request);
    if (!authed) return respErr('Unauthorized', { status: 401 });

    const body = await request.json();
    const { key, category } = body as { key: string; category: string };
    if (!key || !key.startsWith('html/')) return respErr('Invalid key');
    if (!category || !BLOG_CATEGORIES.includes(category)) {
      return respErr('Invalid category');
    }

    const got = await getBlogHtml(key);
    if (!got) return respErr('Not found', { status: 404 });
    if (!canManageBlogHtml(got.meta, authed.viewer)) {
      return respErr('Forbidden', { status: 403 });
    }

    await updateBlogHtmlCategory(key, category);
    return respData({ ok: true, category });
  } catch (error: any) {
    return respErr(error.message || 'Update failed');
  }
}

// DELETE /api/blog/html?key=xxx — 删除 HTML 文件（仅上传者本人或管理员）
async function DELETE({ request }: { request: Request }) {
  try {
    const authed = await requireViewer(request);
    if (!authed) return respErr('Unauthorized', { status: 401 });

    const url = new URL(request.url);
    const key = url.searchParams.get('key');
    if (!key || !key.startsWith('html/')) {
      return respErr('Invalid key');
    }

    const got = await getBlogHtml(key);
    if (!got) return respErr('Not found', { status: 404 });
    if (!canManageBlogHtml(got.meta, authed.viewer)) {
      return respErr('Forbidden', { status: 403 });
    }

    await deleteBlogHtml(key);
    return respData({ ok: true });
  } catch (error: any) {
    return respErr(error.message || 'Delete failed');
  }
}
