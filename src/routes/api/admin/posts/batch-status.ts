import { createFileRoute } from '@tanstack/react-router';
import { runAdminRoute } from '@/server/admin/execute';

export const Route = createFileRoute('/api/admin/posts/batch-status')({
  server: {
    handlers: {
      POST: (context) => runAdminRoute('posts_batch_status', context),
    },
  },
});
