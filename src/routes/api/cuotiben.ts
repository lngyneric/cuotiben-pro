import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import {
  createCard,
  deleteCard,
  getCard,
  getDueCards,
  getStats,
  listCards,
  logAttempt,
  updateCard,
} from '@/modules/cuotiben/service';
import { respData, respErr } from '@/lib/resp';

async function getSession(request: Request) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user ?? null;
}

async function GET({ request }: { request: Request }) {
  try {
    const user = await getSession(request);
    if (!user) return respErr('Unauthorized');

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'list';
    const subject = url.searchParams.get('subject') || undefined;

    if (action === 'due') {
      return respData(await getDueCards(user.id, subject));
    }
    if (action === 'stats') {
      const days = parseInt(url.searchParams.get('days') || '7');
      const since = new Date(Date.now() - days * 86400000);
      return respData(await getStats(user.id, since));
    }
    const cardId = url.searchParams.get('id');
    if (cardId) {
      return respData(await getCard(user.id, cardId));
    }
    return respData(await listCards(user.id, subject));
  } catch (error: any) {
    return respErr(error.message || 'Failed');
  }
}

async function POST({ request }: { request: Request }) {
  try {
    const user = await getSession(request);
    if (!user) return respErr('Unauthorized');

    const body = await request.json();
    const { action } = body;

    if (action === 'create') {
      const id = await createCard(user.id, body.card);
      return respData({ id });
    }
    if (action === 'log') {
      await logAttempt(user.id, body.cardId, body.kind, body.ok, body.skip);
      return respData({ ok: true });
    }
    if (action === 'seed') {
      const { seedCards, getSeedDebug } = await import('@/modules/cuotiben/service');
      const count = await seedCards(user.id);
      return respData({ count, debug: getSeedDebug() });
    }
    return respErr('Unknown action');
  } catch (error: any) {
    return respErr(error.message || 'Failed');
  }
}

async function PUT({ request }: { request: Request }) {
  try {
    const user = await getSession(request);
    if (!user) return respErr('Unauthorized');

    const body = await request.json();
    await updateCard(user.id, body.id, body.card);
    return respData({ ok: true });
  } catch (error: any) {
    return respErr(error.message || 'Failed');
  }
}

async function DELETE({ request }: { request: Request }) {
  try {
    const user = await getSession(request);
    if (!user) return respErr('Unauthorized');

    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) return respErr('Missing id');
    await deleteCard(user.id, id);
    return respData({ ok: true });
  } catch (error: any) {
    return respErr(error.message || 'Failed');
  }
}

export const Route = createFileRoute('/api/cuotiben')({
  server: {
    handlers: { GET, POST, PUT, DELETE },
  },
});
