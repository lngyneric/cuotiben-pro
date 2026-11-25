import { createFileRoute } from '@tanstack/react-router';
import {
  authenticateAdmin,
  checkSessionOrigin,
  requirePermission,
} from '@/server/admin/auth';
import { adminErrorResponse } from '@/server/admin/execute';
import { presentonErrorResponse } from '@/server/admin/handlers/presentations';

import { MAX_FILE_DECODED_BYTES } from '@/modules/ai-assistant/attachments';
import { PresentonError } from '@/modules/presentations/service';
import {
  REFERENCE_PPT_MAX_BYTES,
  registerReferencePpt,
  registerUploadTextBytes,
  sourcePublicView,
} from '@/modules/presentations/sources';
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr } from '@/lib/resp';

// POST /api/ai-assistant/presentations/sources — 页面端的内容源文件登记
// （multipart/form-data），与 MCP 的 presentations_source_add 同一套服务。
//
// 为什么要这个路由：MCP 单次调用限额 2MB，一个 25MB 的参考 PPT 根本
// 进不了 MCP；25MB 是上传文件上限，抽取在服务端做，只有抽出的文本进
// MCP。所以 25MB 的文件走这个页面上传路由，MCP 只登记 2MB 以内的文件。
// kind=upload_text（txt/md/csv/pdf/docx/xls/xlsx，单文件 5MB 解码上限，
// 抽取文本 8000 字上限）或 reference_ppt（.pptx，单文件 25MB 上限）。
async function POST({ request }: { request: Request }) {
  const ipLimited = enforceMinIntervalRateLimit(request, {
    intervalMs: 200,
    keyPrefix: 'ai-assistant-presentations-sources',
  });
  if (ipLimited) return ipLimited;

  try {
    const actor = await authenticateAdmin(request);
    checkSessionOrigin(request, actor);
    requirePermission(actor, 'admin.presentations.generate');

    const formData = await request.formData();
    const kind = String(formData.get('kind') || '');
    const file = formData.get('file');
    if (!(file instanceof File)) return respErr('请提供要登记的文件');
    const bytes = Buffer.from(await file.arrayBuffer());
    const owner = { userId: actor.userId, tokenId: actor.tokenId ?? null };

    if (kind === 'reference_ppt') {
      if (bytes.length > REFERENCE_PPT_MAX_BYTES) {
        const mb = (bytes.length / (1024 * 1024)).toFixed(1);
        throw new PresentonError(
          'invalid_input',
          `参考 PPT「${file.name}」${mb}MB，超过 25MB 上限，无法直接抽取。请先转 PDF（抽文字当内容源）或转图片（当版式参考）再提交。`
        );
      }
      const useRaw = String(formData.get('use') || 'content');
      const use = useRaw === 'style' || useRaw === 'both' ? useRaw : 'content';
      const row = await registerReferencePpt(
        owner,
        { name: file.name, bytes },
        use
      );
      return respData(sourcePublicView(row));
    }
    if (kind === 'upload_text') {
      if (bytes.length > MAX_FILE_DECODED_BYTES)
        return respErr(`文件「${file.name}」超过 5MB，请拆小再传`);
      const row = await registerUploadTextBytes(owner, {
        name: file.name,
        mime: file.type,
        bytes,
      });
      return respData(sourcePublicView(row));
    }
    return respErr('kind 须为 upload_text 或 reference_ppt');
  } catch (error) {
    if (error instanceof PresentonError) return presentonErrorResponse(error);
    return adminErrorResponse(error);
  }
}

export const Route = createFileRoute('/api/ai-assistant/presentations/sources')(
  {
    server: { handlers: { POST } },
  }
);
