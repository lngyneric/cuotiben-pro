import { createFileRoute } from '@tanstack/react-router';
import {
  authenticateAdmin,
  checkSessionOrigin,
  requirePermission,
} from '@/server/admin/auth';
import { adminErrorResponse } from '@/server/admin/execute';
import { presentonErrorResponse } from '@/server/admin/handlers/presentations';

import * as presentationsService from '@/modules/presentations/service';
import { PresentonError } from '@/modules/presentations/service';
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr } from '@/lib/resp';

// GET /api/ai-assistant/presentations/elements?id=<jobId> — 逐页元素按 ID 列出
// （阶段 0 完成标志之一，供阶段 2 单页编辑定位）。
//
// 与下载同一口径：只放行任务属主本人，不存在与非属主一律 404；未完成任务
// 报 409。元素索引优先读任务行缓存（下载盖章时写入），缺失时现算并写回。
async function GET({ request }: { request: Request }) {
  const ipLimited = enforceMinIntervalRateLimit(request, {
    intervalMs: 200,
    keyPrefix: 'ai-assistant-presentations-elements',
  });
  if (ipLimited) return ipLimited;

  try {
    const actor = await authenticateAdmin(request);
    checkSessionOrigin(request, actor);
    requirePermission(actor, 'admin.presentations.read');
    const id = new URL(request.url).searchParams.get('id') || '';
    const job = await presentationsService.findOwnedJob(id, actor);
    // Missing and not-owned are indistinguishable by design.
    if (!job) return respErr('Presentation not found', { status: 404 });
    if (job.status !== 'completed' || !job.exportPath)
      return respErr('Presentation is not ready', { status: 409 });
    const index = await presentationsService.listJobElements(job);
    return respData({
      jobId: job.id,
      slideCount: job.slideCount,
      themeVersion: job.themeVersion ?? undefined,
      pages: index.pages,
    });
  } catch (error) {
    if (error instanceof PresentonError) return presentonErrorResponse(error);
    return adminErrorResponse(error);
  }
}

export const Route = createFileRoute(
  '/api/ai-assistant/presentations/elements'
)({
  server: { handlers: { GET } },
});
