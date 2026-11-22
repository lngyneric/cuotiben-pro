import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import {
  listDashboardRows,
  MENTORING_DASHBOARD_PERMISSION,
  resolveDashboardScope,
  type DashboardView,
} from '@/modules/mentoring-dashboard/service';
import { hasPermission } from '@/modules/rbac/service';
import { respData, respErr } from '@/lib/resp';

// GET /api/mentoring-dashboard/summary?view=admin|hr|mentor&mentorId=<role_person_map id>
//
// 总表数据（只读）。权限：
// - 管理员（admin.mentoring_dashboard.read）：全部行；view 可选 admin/hr/mentor，
//   mentor 视角须指定 mentorId（预览该导师看到的内容）。
// - 导师（role_person_map 角色导师/两者都是，按 wiki 邮箱前缀工号匹配）：
//   只能看导师视角、只看自己名下学员；传 admin/hr 也会被强制成 mentor。
// - 学员本人：总表不开放（403），只能看自己的个人 Dashboard。
// - 其他人：403。
// HR 在 wiki 里目前没有独立角色：hr 视角是展示形态（全部行＋HR 跟进列），
// 仅管理员可切换预览。
async function GET({ request }: { request: Request }) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return respErr('Unauthorized');

  const url = new URL(request.url);
  const viewParam = url.searchParams.get('view') ?? 'admin';
  const mentorIdParam = url.searchParams.get('mentorId') ?? null;

  const isAdmin = await hasPermission(
    session.user.id,
    MENTORING_DASHBOARD_PERMISSION
  ).catch(() => false);
  const employeeNo = session.user.email?.split('@')[0]?.toLowerCase() ?? '';
  const scope = await resolveDashboardScope({ isAdmin, employeeNo });
  if (!scope || scope.kind === 'self')
    return respErr('Forbidden', { status: 403 });

  let view: DashboardView = 'admin';
  if (viewParam === 'hr' || viewParam === 'mentor') view = viewParam;
  else if (viewParam !== 'admin')
    return respErr('Invalid view', { status: 400 });

  const result = await listDashboardRows(scope, view, mentorIdParam);
  if ('error' in result) {
    if (result.error === 'mentor_not_found')
      return respErr('Mentor not found', { status: 400 });
    return respErr('Forbidden', { status: 403 });
  }
  return respData(result);
}

export const Route = createFileRoute('/api/mentoring-dashboard/summary')({
  server: { handlers: { GET } },
});
