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
  updateBlogHtmlKeywords,
  updateBlogHtmlVisibility,
  type BlogHtmlVisibility,
} from '@/modules/blog-html/storage';
import * as taxonomyService from '@/modules/taxonomy/service';
import { respData, respErr } from '@/lib/resp';

// HTML 分类的唯一来源：taxonomy 字典（type='category' 且已发布）+
// 遗留默认值“未分类”。上传/编辑页的下拉框与这里的校验用同一份名单。
const UNCATEGORIZED = '未分类';

async function allowedHtmlCategories(): Promise<string[]> {
  const items = await taxonomyService.getAll('category');
  return [UNCATEGORIZED, ...items.map((c) => c.title)];
}

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

    // 分类：优先用表单提交的 category（下拉框，只接受字典值），否则按
    // 内容自动打标。自动打标的旧规则（G8学习/错题解析/工具）不在字典里，
    // 是遗留行为：这类文章之后在列表里改一次分类即归入字典。
    const manualCategory = (formData.get('category') as string)?.trim();
    let category: string;
    if (manualCategory) {
      const allowed = await allowedHtmlCategories();
      if (!allowed.includes(manualCategory)) {
        return respErr('Invalid category');
      }
      category = manualCategory;
    } else {
      category = autoCategorize(title, description, content);
    }

    // 关键词：逗号分隔自由文本，可空；随元数据一起存（本地 SQLite 列 /
    // R2 customMetadata），供 AI 助手检索打分。
    const keywords = (formData.get('keywords') as string)?.trim() || '';

    // 可见范围：public（共享公开，无需登录）/ all（全体已注册可见，默认）
    // 或 self（仅自己和管理员可见）
    const visibilityParam = (formData.get('visibility') as string)?.trim();
    const visibility: BlogHtmlVisibility =
      visibilityParam === 'self'
        ? 'self'
        : visibilityParam === 'public'
          ? 'public'
          : 'all';

    const key = `html/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const item = await putBlogHtml(key, content, {
      title,
      description,
      category,
      keywords,
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

// PATCH /api/blog/html — 修改分类、关键词和/或可见范围（仅上传者本人或管理员）
// Body: { key, category?: string, keywords?: string, visibility?: 'all' | 'self' | 'public' }
async function PATCH({ request }: { request: Request }) {
  try {
    const authed = await requireViewer(request);
    if (!authed) return respErr('Unauthorized', { status: 401 });

    const body = await request.json();
    const { key, category, keywords, visibility } = body as {
      key: string;
      category?: string;
      keywords?: string;
      visibility?: string;
    };
    if (!key || !key.startsWith('html/')) return respErr('Invalid key');
    if (category !== undefined) {
      const allowed = await allowedHtmlCategories();
      if (!allowed.includes(category)) {
        return respErr('Invalid category');
      }
    }
    const nextVisibility: BlogHtmlVisibility | undefined =
      visibility === undefined
        ? undefined
        : visibility === 'self'
          ? 'self'
          : visibility === 'public'
            ? 'public'
            : visibility === 'all'
              ? 'all'
              : undefined;
    if (visibility !== undefined && nextVisibility === undefined) {
      return respErr('Invalid visibility');
    }
    if (
      category === undefined &&
      keywords === undefined &&
      nextVisibility === undefined
    ) {
      return respErr('Nothing to update');
    }

    const got = await getBlogHtml(key);
    if (!got) return respErr('Not found', { status: 404 });
    if (!canManageBlogHtml(got.meta, authed.viewer)) {
      return respErr('Forbidden', { status: 403 });
    }

    if (category !== undefined) {
      await updateBlogHtmlCategory(key, category);
    }
    if (keywords !== undefined) {
      await updateBlogHtmlKeywords(key, String(keywords).trim());
    }
    if (nextVisibility !== undefined) {
      await updateBlogHtmlVisibility(key, nextVisibility);
    }
    return respData({
      ok: true,
      category: category ?? got.meta.category,
      keywords:
        keywords !== undefined ? String(keywords).trim() : got.meta.keywords,
      visibility: nextVisibility ?? got.meta.visibility,
    });
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
