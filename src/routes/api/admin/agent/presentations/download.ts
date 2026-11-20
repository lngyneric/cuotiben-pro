import { createFileRoute } from '@tanstack/react-router';
import {
  authenticateAdmin,
  checkSessionOrigin,
  requirePermission,
} from '@/server/admin/auth';
import { adminErrorResponse } from '@/server/admin/execute';

import * as presentationsService from '@/modules/presentations/service';
import { PresentonError } from '@/modules/presentations/service';

// PPTX 下载：只放行任务属主本人；不存在与非属主一律 404，不泄露任务存在与否。
// pptx 字节由 wiki 实时向 Presenton 取回再转发，Presenton 的原生地址与
// 编辑地址绝不暴露给调用方。
export const Route = createFileRoute('/api/admin/agent/presentations/download')(
  {
    server: {
      handlers: {
        GET: async ({ request }) => {
          try {
            const actor = await authenticateAdmin(request);
            checkSessionOrigin(request, actor);
            requirePermission(actor, 'admin.presentations.read');
            const id = new URL(request.url).searchParams.get('id') || '';
            const job = await presentationsService.findOwnedJob(id, actor);
            if (!job) return new Response('Not found', { status: 404 });
            if (job.status !== 'completed' || !job.exportPath)
              return new Response('Presentation is not ready', {
                status: 409,
              });
            const bytes = await presentationsService.downloadJobPptx(job);
            return new Response(bytes as unknown as BodyInit, {
              status: 200,
              headers: {
                'Content-Type':
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                'Content-Disposition': `attachment; filename="presentation-${job.id}.pptx"`,
                'Content-Length': String(bytes.byteLength),
                'Cache-Control': 'no-store',
              },
            });
          } catch (error) {
            if (error instanceof PresentonError)
              return new Response(error.message, {
                status: error.status >= 500 ? 502 : error.status,
              });
            return adminErrorResponse(error);
          }
        },
      },
    },
  }
);
