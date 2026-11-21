import * as presentationsService from '@/modules/presentations/service';
import { PresentonError } from '@/modules/presentations/service';
import { withAppBase } from '@/lib/base-path';
import { respData, respErr } from '@/lib/resp';

import type { AdminHandlerContext } from '../types';

export function presentonErrorResponse(error: unknown) {
  if (error instanceof PresentonError) {
    const status =
      error.code === 'llm_quota_exceeded'
        ? 429
        : error.code === 'not_configured'
          ? 503
          : error.code === 'invalid_input'
            ? 400
            : 502;
    return respErr(error.message, { status });
  }
  return respErr(error instanceof Error ? error.message : 'Internal error');
}

export async function POST({ request, actor }: AdminHandlerContext) {
  try {
    const body = await request.json();
    const job = await presentationsService.createJobAndStart({
      ownerUserId: actor.userId,
      ownerTokenId: actor.tokenId ?? null,
      input: {
        content: body.content,
        nSlides: body.nSlides,
        language: body.language,
        template: body.template,
        mode: body.mode || 'standard',
        instructions: body.instructions,
        files: body.files,
        postSlugs: body.postSlugs,
      },
    });
    return respData({ jobId: job.id, status: job.status });
  } catch (error) {
    return presentonErrorResponse(error);
  }
}

export async function GET({ params, actor }: AdminHandlerContext) {
  try {
    const job = await presentationsService.findOwnedJob(params.id, actor);
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
            downloadUrl: withAppBase(
              `/api/admin/agent/presentations/download?id=${encodeURIComponent(current.id)}`
            ),
          }
        : {}),
      ...(current.status === 'failed'
        ? { error: current.error, errorCode: current.errorCode }
        : {}),
    });
  } catch (error) {
    return presentonErrorResponse(error);
  }
}
