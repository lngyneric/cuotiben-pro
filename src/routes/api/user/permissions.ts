import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { getUserPermissionCodes, hasPermission } from '@/modules/rbac/service';
import { respData, respErr } from '@/lib/resp';

async function GET({ request }: { request: Request }) {
  try {
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return respErr('Unauthorized');

    const isAdmin = await hasPermission(session.user.id, 'admin.*');
    // 自己的权限码也一并返回，供页面按权限显隐入口（如助手页的生成 PPT
    // 按钮）；服务端接口仍各自鉴权，这里只决定“显不显示”。
    const permissions = await getUserPermissionCodes(session.user.id);
    return respData({ isAdmin, permissions });
  } catch (error: any) {
    return respErr(error.message || 'Internal error');
  }
}

export const Route = createFileRoute('/api/user/permissions')({
  server: {
    handlers: { GET },
  },
});
