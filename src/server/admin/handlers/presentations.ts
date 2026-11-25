import { matchPermission } from '@/core/auth/rbac';
import { envConfigs } from '@/config';
import { registerImage, searchImages } from '@/modules/presentations/images';
import * as presentationsService from '@/modules/presentations/service';
import { PresentonError } from '@/modules/presentations/service';
import {
  buildOutline,
  confirmOutline,
  getOwnedSources,
  registerReferencePpt,
  registerUploadText,
  registerWikiKb,
  searchWikiKb,
  sourcePublicView,
  viewerFor,
} from '@/modules/presentations/sources';
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
            : error.code === 'generation_timeout'
              ? 504
              : 502;
    return respErr(error.message, { status });
  }
  return respErr(error instanceof Error ? error.message : 'Internal error');
}

/** 与客户端 isAdmin 同一口径：字面量 admin.*（或 *）才算管理员。 */
function isAdminActor(actor: AdminHandlerContext['actor']): boolean {
  return matchPermission('admin.*', actor.permissions);
}

function decodeBase64Input(base64: string, name: string): Buffer {
  const compact = (base64 || '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0)
    throw new PresentonError(
      'invalid_input',
      `文件「${name}」不是有效的 base64 内容`
    );
  return Buffer.from(compact, 'base64');
}

export async function POST({ request, actor }: AdminHandlerContext) {
  try {
    const body = await request.json();
    const job = await presentationsService.createJobAndStart({
      ownerUserId: actor.userId,
      ownerTokenId: actor.tokenId ?? null,
      isAdmin: isAdminActor(actor),
      input: {
        content: body.content,
        nSlides: body.nSlides,
        language: body.language,
        template: body.template,
        mode: body.mode || 'standard',
        instructions: body.instructions,
        files: body.files,
        postSlugs: body.postSlugs,
        sourceIds: body.sourceIds,
        outlineId: body.outlineId,
        images: body.images,
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
    const provenance = presentationsService.jobProvenanceView(current);
    return respData({
      jobId: current.id,
      status: current.status,
      title: current.title,
      slideCount: current.slideCount,
      // 阶段 0：生成时写入的主题版本（layouts.ts 的单一主题来源）。
      ...(current.themeVersion ? { themeVersion: current.themeVersion } : {}),
      // 阶段 1：来源模式与留痕。无来源生成时 sourceMode 为 unsourced，
      // 调用方须在结果中标注“无来源生成”，不得假装有来源。
      sourceMode: provenance.sourceMode,
      ...(provenance.layoutAssignments
        ? { layoutAssignments: provenance.layoutAssignments }
        : {}),
      ...(provenance.pageSourceRefs
        ? { pageSourceRefs: provenance.pageSourceRefs }
        : {}),
      ...(provenance.imageAssignments
        ? { imageAssignments: provenance.imageAssignments }
        : {}),
      ...(provenance.missingImagePages.length > 0
        ? {
            missingImagePages: provenance.missingImagePages,
            missingImagesNote: `第 ${provenance.missingImagePages.join('、')} 页缺图`,
          }
        : {}),
      ...(current.status === 'completed'
        ? {
            // Absolute URL: an MCP agent is an external client — a
            // relative path leaves it unable to link the file, and it
            // ends up asking the user for the site address instead.
            // The handler's synthetic request is http://admin.internal,
            // so the origin comes from VITE_APP_URL (intranet:
            // https://eu.sysmex.com.cn/wiki), never from request.url.
            downloadUrl: `${new URL(envConfigs.app_url).origin}${withAppBase(
              `/api/admin/agent/presentations/download?id=${encodeURIComponent(current.id)}`
            )}`,
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

// ─── 阶段 1：内容源 ─────────────────────────────────────────────────────────

export async function sourceAdd({ request, actor }: AdminHandlerContext) {
  try {
    const body = await request.json();
    const owner = { userId: actor.userId, tokenId: actor.tokenId ?? null };
    const kind = body.kind;
    if (kind === 'upload_text') {
      if (!body.file)
        throw new PresentonError('invalid_input', '请提供要登记的文件');
      const row = await registerUploadText(owner, {
        name: body.file.name,
        mime: body.file.mime,
        base64: body.file.base64,
      });
      return respData(sourcePublicView(row));
    }
    if (kind === 'reference_ppt') {
      if (!body.file)
        throw new PresentonError('invalid_input', '请提供要登记的参考 PPT');
      const bytes = decodeBase64Input(body.file.base64 ?? '', body.file.name);
      const use =
        body.use === 'style' || body.use === 'both' ? body.use : 'content';
      const row = await registerReferencePpt(
        owner,
        { name: body.file.name, bytes },
        use
      );
      const view = sourcePublicView(row);
      let meta: Record<string, any> = {};
      try {
        meta = row.meta ? JSON.parse(row.meta) : {};
      } catch {
        meta = {};
      }
      return respData({
        ...view,
        use: meta.use ?? 'content',
        slides: Array.isArray(meta.slides)
          ? meta.slides.map((s: any) => ({
              pageNo: s.pageNo,
              title: s.title,
            }))
          : [],
        themeColors: Array.isArray(meta.themeColors) ? meta.themeColors : [],
      });
    }
    if (kind === 'wiki_kb') {
      const viewer = await viewerFor(actor.userId, actor.tokenId ?? null);
      if (Array.isArray(body.postIds) && body.postIds.length > 0) {
        const items = body.postIds.map((p: any) => ({
          refType: p.refType === 'html' ? ('html' as const) : ('post' as const),
          refId: String(p.refId),
        }));
        const row = await registerWikiKb(owner, viewer, items);
        return respData(sourcePublicView(row));
      }
      // 无 postIds：只做检索、返回命中清单供勾选，不登记来源。
      const { hits } = await searchWikiKb(viewer, String(body.keyword ?? ''));
      return respData({
        hits,
        needsSelection: true,
        ...(hits.length === 0
          ? { message: '无可用来源：知识库中没有命中该主题的已发布内容' }
          : {}),
      });
    }
    throw new PresentonError(
      'invalid_input',
      'kind 须为 upload_text、reference_ppt 或 wiki_kb'
    );
  } catch (error) {
    return presentonErrorResponse(error);
  }
}

// ─── 阶段 1：页面划分草稿 ───────────────────────────────────────────────────

export async function outlineDraft({ request, actor }: AdminHandlerContext) {
  try {
    const body = await request.json();
    const owner = { userId: actor.userId, tokenId: actor.tokenId ?? null };
    const outline = await buildOutline(owner, body.sourceIds);
    return respData({
      outlineId: outline.id,
      status: outline.status,
      version: outline.version,
      pages: JSON.parse(outline.pages),
    });
  } catch (error) {
    return presentonErrorResponse(error);
  }
}

export async function outlineConfirm({ request, actor }: AdminHandlerContext) {
  try {
    const body = await request.json();
    const owner = { userId: actor.userId, tokenId: actor.tokenId ?? null };
    const outline = await confirmOutline(owner, body.outlineId, body.pages);
    return respData({
      outlineId: outline.id,
      status: outline.status,
      version: outline.version,
      pages: JSON.parse(outline.pages),
    });
  } catch (error) {
    return presentonErrorResponse(error);
  }
}

// ─── 阶段 1：图片库 ─────────────────────────────────────────────────────────

export async function imageUpload({ request, actor }: AdminHandlerContext) {
  try {
    const body = await request.json();
    const owner = { userId: actor.userId, tokenId: actor.tokenId ?? null };
    if (!body.file)
      throw new PresentonError('invalid_input', '请提供要上传的图片');
    const sourceType = body.sourceType === 'paste' ? 'paste' : 'upload';
    const row = await registerImage(
      owner,
      {
        name: body.file.name,
        mime: body.file.mime,
        base64: body.file.base64,
      },
      sourceType,
      typeof body.tags === 'string' ? body.tags : ''
    );
    return respData({
      imageId: row.id,
      sourceType: row.sourceType,
      sourceRef: row.sourceRef,
      fileName: row.fileName,
      width: row.width,
      height: row.height,
      fileSize: row.fileSize,
      storageUrl: row.storageUrl,
    });
  } catch (error) {
    return presentonErrorResponse(error);
  }
}

export async function imageSearch({ request, actor }: AdminHandlerContext) {
  try {
    const body = await request.json().catch(() => ({}));
    const viewer = await viewerFor(actor.userId, actor.tokenId ?? null);
    const { items } = await searchImages(viewer, {
      q: body.q,
      tags: body.tags,
      sourceType: body.sourceType,
      sort: body.sort === 'recent' ? 'recent' : 'newest',
      limit: body.limit,
    });
    return respData({ items });
  } catch (error) {
    return presentonErrorResponse(error);
  }
}

/** 供页面路由复用的来源读取（归属校验与 MCP 同口径）。 */
export { getOwnedSources };
