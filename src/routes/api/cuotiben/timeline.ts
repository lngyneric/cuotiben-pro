import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { getWikiTimeline } from '@/modules/cuotiben/timeline';
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr } from '@/lib/resp';

// GET /api/cuotiben/timeline — Wiki 操作时间线（只读聚合）。
// 登录后可调；先 IP 限流（200ms），再按人限流（2 秒），与 ai-assistant
// 路由同一做法。返回 { events, todos }，不含密码、token、密钥、问句原文。
async function GET({ request }: { request: Request }) {
  const ipLimited = enforceMinIntervalRateLimit(request, {
    intervalMs: 200,
    keyPrefix: 'cuotiben-timeline',
  });
  if (ipLimited) return ipLimited;

  try {
    const session = await getAuth().api.getSession({
      headers: request.headers,
    });
    if (!session?.user) return respErr('Unauthorized', { status: 401 });

    const limited = enforceMinIntervalRateLimit(request, {
      intervalMs: 2_000,
      keyPrefix: 'cuotiben-timeline',
      extraKey: session.user.id,
    });
    if (limited) return limited;

    return respData(await getWikiTimeline(session.user.id));
  } catch {
    return respErr('时间线暂不可用，请稍后再试', { status: 503 });
  }
}

export const Route = createFileRoute('/api/cuotiben/timeline')({
  server: { handlers: { GET } },
});
