import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import {
  createCard,
  deleteCard,
  getCard,
  getDueCards,
  getStats,
  isMathCard,
  listCards,
  logAttempt,
  qaApproaches,
  qaFollowup,
  qaHint,
  qaJudge,
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
      const { seedCards, getSeedDebug } =
        await import('@/modules/cuotiben/service');
      const count = await seedCards(user.id);
      return respData({ count, debug: getSeedDebug() });
    }
    if (action === 'import') {
      const { createCard } = await import('@/modules/cuotiben/service');
      const cards = body.cards;
      if (!Array.isArray(cards)) return respErr('cards must be an array');
      let count = 0;
      for (const c of cards) {
        if (!c.question) continue;
        await createCard(user.id, {
          src: c.src || '',
          subject: c.subject || '',
          tag: c.tag || '',
          kind: c.kind || '',
          question: c.question || '',
          myAnswer: c.myAnswer || '',
          answer: c.answer || '',
          principle: c.principle || '',
          note: c.note || '',
          diagram: c.diagram || null,
          mastered: false,
        });
        count++;
      }
      return respData({ count });
    }
    if (action === 'qa') {
      // 问答接口：op = approaches | judge | hint | followup
      // 当前为 MOCK 实现；接入 Workers AI 后替换 service 层函数体即可
      const op = body.op;
      if (op === 'approaches') {
        const card = body.cardId ? await getCard(user.id, body.cardId) : null;
        if (!card) return respErr('Card not found');
        const { options, followup } = await qaApproaches(card);
        return respData({ mock: true, options, followup });
      }
      if (op === 'followup') {
        const card = body.cardId ? await getCard(user.id, body.cardId) : null;
        if (!card) return respErr('Card not found');
        return respData({ mock: true, ...(await qaFollowup(card)) });
      }
      if (op === 'hint') {
        const card = body.cardId ? await getCard(user.id, body.cardId) : null;
        const { hint } = await qaHint(
          { principle: card?.principle || body.principle || '' },
          body.student || '',
          body.attempt || 0
        );
        return respData({ mock: true, hint });
      }
      if (op === 'judge') {
        const expected =
          body.expected ||
          (body.cardId ? (await getCard(user.id, body.cardId))?.answer : '') ||
          '';
        const { correct, confidence } = await qaJudge(
          expected,
          body.student || ''
        );
        return respData({ mock: true, correct, confidence });
      }
      return respErr('Unknown qa op');
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
