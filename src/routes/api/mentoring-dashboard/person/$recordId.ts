import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import {
  getDashboardPerson,
  MENTORING_DASHBOARD_PERMISSION,
  resolveDashboardScope,
} from '@/modules/mentoring-dashboard/service';
import { hasPermission } from '@/modules/rbac/service';
import { respData, respErr } from '@/lib/resp';

// GET /api/mentoring-dashboard/person/:recordId — 个人 Dashboard（一行带教记录）。
//
// recordId 是 user_status_summary 的 id（`record:<智能表行 id>`，也可只传行 id）。
// 权限：管理员看任意行；导师只看自己名下学员的行（＋自己的行）；学员只看自己的行。
async function GET({
  request,
  params,
}: {
  request: Request;
  params: { recordId: string };
}) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return respErr('Unauthorized');

  const isAdmin = await hasPermission(
    session.user.id,
    MENTORING_DASHBOARD_PERMISSION
  ).catch(() => false);
  const employeeNo = session.user.email?.split('@')[0]?.toLowerCase() ?? '';
  const scope = await resolveDashboardScope({ isAdmin, employeeNo });
  if (!scope) return respErr('Forbidden', { status: 403 });

  let recordId: string;
  try {
    recordId = decodeURIComponent(params.recordId);
  } catch {
    return respErr('Invalid id', { status: 400 });
  }
  const result = await getDashboardPerson(scope, recordId);
  if ('error' in result) {
    if (result.error === 'not_found')
      return respErr('Not found', { status: 404 });
    return respErr('Forbidden', { status: 403 });
  }
  return respData(result.person);
}

export const Route = createFileRoute(
  '/api/mentoring-dashboard/person/$recordId'
)({
  server: { handlers: { GET } },
});
