import { createFileRoute } from '@tanstack/react-router';
import {
  authenticateAdmin,
  checkSessionOrigin,
  requirePermission,
} from '@/server/admin/auth';
import { adminErrorResponse } from '@/server/admin/execute';
import { presentonErrorResponse } from '@/server/admin/handlers/presentations';

import {
  buildOutline,
  confirmOutline,
  outlineVerdictView,
  registerUploadTextBytes,
} from '@/modules/presentations/sources';
import { PresentonError } from '@/modules/presentations/service';
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr } from '@/lib/resp';

// POST /api/ai-assistant/presentations/outline — AI 学习助手 PPT 页签的
// outline 步骤入口（导航＋意图优化，P0 遗留的前端 outline 步骤）。
//
// 与 MCP 的 presentations_outline / presentations_outline_confirm 是
// 同一套服务（buildOutline / confirmOutline），只是调用方是登录的
// wiki 用户（session），不是 agent key。权限复用现有的
// admin.presentations.generate，不新增权限码。
//
// action=create：从一句话/一段文字建页面划分草稿——先把文本登记为
// upload_text 来源，再页面划分：上传文本优先走 Magpie LLM 分组（失败
// 回退确定性拆分），草稿建好后调 Jev 判定分组（不通过自动重分一次，
// 再不通过标疑点返回）；也可直接传已登记的 sourceIds。返回 outlineId
// + pages 草稿 + verdict，供页签展示确认。
// action=confirm：确认草稿（可传调整后的 pages：改标题/要点、删页、
// 合并页；页码须连续、来源须是已登记的），返回已确认的 outline。
// 生成（POST /api/ai-assistant/presentations）须带已确认的 outlineId。

async function POST({ request }: { request: Request }) {
  const ipLimited = enforceMinIntervalRateLimit(request, {
    intervalMs: 200,
    keyPrefix: 'ai-assistant-presentations-outline',
  });
  if (ipLimited) return ipLimited;

  try {
    const actor = await authenticateAdmin(request);
    checkSessionOrigin(request, actor);
    requirePermission(actor, 'admin.presentations.generate');

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return respErr('Invalid request', { status: 400 });
    }
    const owner = { userId: actor.userId, tokenId: actor.tokenId ?? null };

    if (body?.action === 'confirm') {
      const outlineId =
        typeof body?.outlineId === 'string' ? body.outlineId : '';
      if (!outlineId)
        return respErr('outlineId is required', { status: 400 });
      const outline = await confirmOutline(owner, outlineId, body?.pages);
      return respData({
        outlineId: outline.id,
        status: outline.status,
        version: outline.version,
        pages: JSON.parse(outline.pages),
        sourceIds: JSON.parse(outline.sourceIds),
        verdict: outlineVerdictView(outline),
      });
    }

    if (body?.action !== 'create')
      return respErr("action must be 'create' or 'confirm'", { status: 400 });

    // 建草稿会调 Magpie LLM 分组 + Jev 判定（60 秒 + 15 秒级超时），
    // 不是轻操作：每人 2 秒内只能建一个，避免重复点击重复登记来源。
    const limited = enforceMinIntervalRateLimit(request, {
      intervalMs: 2_000,
      keyPrefix: 'ai-assistant-presentations-outline-create',
      extraKey: actor.userId,
    });
    if (limited) return limited;

    let sourceIds: string[];
    if (Array.isArray(body?.sourceIds) && body.sourceIds.length > 0) {
      sourceIds = body.sourceIds.map(String);
    } else if (typeof body?.content === 'string' && body.content.trim()) {
      const row = await registerUploadTextBytes(owner, {
        name:
          typeof body?.name === 'string' && body.name.trim()
            ? body.name.trim().slice(0, 191)
            : '输入内容.txt',
        mime: 'text/plain',
        bytes: Buffer.from(body.content),
      });
      sourceIds = [row.id];
    } else {
      return respErr('content or sourceIds is required', { status: 400 });
    }

    const outline = await buildOutline(owner, sourceIds, {
      intent:
        typeof body?.intent === 'string'
          ? body.intent
          : typeof body?.content === 'string'
            ? body.content
            : undefined,
    });
    return respData({
      outlineId: outline.id,
      status: outline.status,
      version: outline.version,
      pages: JSON.parse(outline.pages),
      sourceIds: JSON.parse(outline.sourceIds),
      verdict: outlineVerdictView(outline),
    });
  } catch (error) {
    if (error instanceof PresentonError) return presentonErrorResponse(error);
    return adminErrorResponse(error);
  }
}

export const Route = createFileRoute('/api/ai-assistant/presentations/outline')(
  {
    server: { handlers: { POST } },
  }
);
