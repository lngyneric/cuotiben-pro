import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import * as taxonomyService from '@/modules/taxonomy/service';
import { respData, respErr } from '@/lib/resp';

// GET /api/blog/html-categories — HTML 上传/编辑页的分类下拉框。
// 返回 taxonomy 字典里已发布的分类（标题 + slug）。任何登录用户都可
// 读，与管理页 /api/admin/categories（要 categories.read 权限）分开，
// 因为 /html 页的上传与改分类不对普通登录用户设管理员门槛。
async function GET({ request }: { request: Request }) {
  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return respErr('Unauthorized', { status: 401 });
    const items = await taxonomyService.getAll('category');
    return respData({
      items: items.map((c) => ({ title: c.title, slug: c.slug })),
    });
  } catch (error: any) {
    return respErr(error.message || 'Failed');
  }
}

export const Route = createFileRoute('/api/blog/html-categories')({
  server: {
    handlers: { GET },
  },
});
