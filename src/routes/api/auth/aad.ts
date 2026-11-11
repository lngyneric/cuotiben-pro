import { createFileRoute } from '@tanstack/react-router';

import {
  createAadSessionCookie,
  findOrCreateAadUser,
  verifyAadEmployee,
} from '@/modules/aad/service';
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr } from '@/lib/resp';

// POST /api/auth/aad — 内部 AAD（企业账号）登录。
//
// Body: { employeeNo, password }（工号 + 内部 AAD 密码）。
// 通过后按工号找或建 better-auth 用户并签发会话（Set-Cookie），
// 之后与邮箱登录完全相同（getSession / useSession 照常用）。
//
// 错误一定分开：
// - 401 工号或密码不正确（AAD 明确拒绝）
// - 503 企业账号服务暂时不可用（AAD 不可达/超时）
// 密码只出现在本次请求的内存里：不记日志、不落库、不回显。
async function POST({ request }: { request: Request }) {
  // 每个 IP 每 2 秒一次，防撞库；工号维度再限一次。
  const ipLimited = enforceMinIntervalRateLimit(request, {
    intervalMs: 2000,
    keyPrefix: 'auth-aad',
  });
  if (ipLimited) return ipLimited;

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return respErr('Invalid request', { status: 400 });
  }
  const employeeNo = String(body?.employeeNo ?? '').trim();
  const password = String(body?.password ?? '');
  if (!employeeNo || !password) {
    return respErr('请输入工号和密码', { status: 400 });
  }

  const noLimited = enforceMinIntervalRateLimit(request, {
    intervalMs: 2000,
    keyPrefix: 'auth-aad',
    extraKey: employeeNo.toLowerCase(),
  });
  if (noLimited) return noLimited;

  const verified = await verifyAadEmployee(employeeNo, password);
  if (!verified.ok) {
    if (verified.reason === 'aad_unavailable') {
      return respErr('企业账号服务暂时不可用，请稍后再试', { status: 503 });
    }
    return respErr('工号或密码不正确', { status: 401 });
  }

  try {
    const { user } = await findOrCreateAadUser(employeeNo);
    const setCookie = await createAadSessionCookie(user.id);
    return respData(
      {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          employeeNo: employeeNo.toLowerCase(),
        },
      },
      { headers: { 'Set-Cookie': setCookie } }
    );
  } catch (error: any) {
    return respErr(error.message || 'Sign in failed');
  }
}

export const Route = createFileRoute('/api/auth/aad')({
  server: {
    handlers: { POST },
  },
});
