import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { envConfigs } from '@/config';
import {
  buildSsoUrl,
  buildWikiDestination,
  deriveEmployeeNo,
  mintSsoJwt,
} from '@/modules/sso/service';
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr } from '@/lib/resp';

// GET /api/auth/sso?next=<wiki page>
//
// Mint a short-lived signed JWT for the wiki -> ai-shifu SSO bridge and
// return the ai-shifu SSO URL. The browser navigates there; ai-shifu
// verifies the token, sets its own `token` cookie, and redirects back to
// `next` — so one wiki login leaves the user signed in on both systems.
//
// - Requires a wiki session (401 otherwise).
// - Requires the session user to be an AAD user (email
//   `<employeeNo>@sysmex.internal`); otherwise 400.
// - Requires SSO_SHARED_SECRET to be configured; otherwise 500 (fail
//   closed — the client then skips the bridge and login proceeds normally).
// - `next` must be a /wiki/ path or a URL on the wiki origin; anything
//   else falls back to the wiki home (no open redirect).
// - Light rate limit: one bridge hop per login, 2 s minimum interval per
//   employee, so the token-minting endpoint can't be hammered.
async function GET({ request }: { request: Request }) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return respErr('Unauthorized', { status: 401 });
  }

  const employeeNo = deriveEmployeeNo(session.user.email);
  if (!employeeNo) {
    return respErr('当前账号不是企业账号（工号登录），无法同步登录 ai-shifu', {
      status: 400,
    });
  }

  const secret = envConfigs.sso_shared_secret || '';
  if (!secret) {
    return respErr('SSO 未配置', { status: 500 });
  }

  const limited = enforceMinIntervalRateLimit(request, {
    intervalMs: 2000,
    keyPrefix: 'auth-sso',
    extraKey: employeeNo,
  });
  if (limited) return limited;

  const url = new URL(request.url);
  const next = buildWikiDestination(url.searchParams.get('next'));
  const token = mintSsoJwt(secret, employeeNo);
  return respData({ ssoUrl: buildSsoUrl(token, next) });
}

export const Route = createFileRoute('/api/auth/sso')({
  server: {
    handlers: { GET },
  },
});
