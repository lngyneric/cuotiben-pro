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

// POST /api/ai-assistant/presentations — AI 学习助手页的 PPT 生成入口。
//
// 与 MCP 的 presentations_generate 是同一套服务（createJobAndStart），
// 只是调用方是登录的 wiki 用户（session），不是 agent key：
// authenticateAdmin 同时接受 session cookie 与 Bearer agent key，
// 归属按 (userId, tokenId) 配对，session 调用方 tokenId 为空；
// 查询与下载只放行属主，不存在与非属主一律 404。
// 权限复用现有的 admin.presentations.generate / .read，不新增权限码。

async function POST({ request }: { request: Request }) {
  const ipLimited = enforceMinIntervalRateLimit(request, {
    intervalMs: 200,
    keyPrefix: 'ai-assistant-presentations',
  });
  if (ipLimited) return ipLimited;

  try {
    const actor = await authenticateAdmin(request);
    checkSessionOrigin(request, actor);
    requirePermission(actor, 'admin.presentations.generate');

    // 生成是重操作：每人 10 秒内只能建一个任务。
    const limited = enforceMinIntervalRateLimit(request, {
      intervalMs: 10_000,
      keyPrefix: 'ai-assistant-presentations-create',
      extraKey: actor.userId,
    });
    if (limited) return limited;

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return respErr('Invalid request', { status: 400 });
    }
    const nSlides =
      body?.nSlides === undefined || body?.nSlides === null
        ? undefined
        : Number(body.nSlides);
    if (
      nSlides !== undefined &&
      (!Number.isInteger(nSlides) || nSlides < 1 || nSlides > 50)
    )
      return respErr('nSlides must be between 1 and 50', { status: 400 });
    const job = await presentationsService.createJobAndStart({
      ownerUserId: actor.userId,
      ownerTokenId: actor.tokenId ?? null,
      input: {
        content: String(body?.content ?? ''),
        nSlides,
        mode: body?.mode === 'smart' ? 'smart' : 'standard',
        instructions: String(body?.instructions ?? '').trim() || undefined,
      },
    });
    return respData({ jobId: job.id, status: job.status });
  } catch (error) {
    if (error instanceof PresentonError) return presentonErrorResponse(error);
    return adminErrorResponse(error);
  }
}

async function GET({ request }: { request: Request }) {
  const ipLimited = enforceMinIntervalRateLimit(request, {
    intervalMs: 200,
    keyPrefix: 'ai-assistant-presentations',
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
    let current = job;
    try {
      current = await presentationsService.refreshJob(job);
    } catch {
      // Refresh is best-effort; report the last known status instead.
    }
    return respData({
      jobId: current.id,
      status: current.status,
      title: current.title,
      slideCount: current.slideCount,
      ...(current.status === 'completed'
        ? {
            downloadUrl: `/api/admin/agent/presentations/download?id=${encodeURIComponent(current.id)}`,
          }
        : {}),
      ...(current.status === 'failed'
        ? { error: current.error, errorCode: current.errorCode }
        : {}),
    });
  } catch (error) {
    if (error instanceof PresentonError) return presentonErrorResponse(error);
    return adminErrorResponse(error);
  }
}

export const Route = createFileRoute('/api/ai-assistant/presentations')({
  server: { handlers: { POST, GET } },
});
