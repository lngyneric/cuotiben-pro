import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import {
  answerPractice,
  createCard,
  createPractice,
  deleteCard,
  deletePractice,
  generateSimilar,
  getCard,
  getDueCards,
  getStats,
  isMathCard,
  listCards,
  listPractice,
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
    if (action === 'practice') {
      return respData(await listPractice(user.id, subject));
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
      const op = body.op;
      if (op === 'approaches') {
        const card = body.cardId ? await getCard(user.id, body.cardId) : null;
        if (!card) return respErr('Card not found');
        const result = await qaApproaches(card);
        return respData(result);
      }
      if (op === 'followup') {
        const card = body.cardId ? await getCard(user.id, body.cardId) : null;
        if (!card) return respErr('Card not found');
        return respData(await qaFollowup(card));
      }
      if (op === 'hint') {
        const card = body.cardId ? await getCard(user.id, body.cardId) : null;
        const result = await qaHint(
          {
            principle: card?.principle || body.principle || '',
            question: card?.question || body.question || '',
          },
          body.student || '',
          body.attempt || 0
        );
        return respData(result);
      }
      if (op === 'judge') {
        const card = body.cardId ? await getCard(user.id, body.cardId) : null;
        const question = body.question || card?.question || '';
        const expected = body.expected || card?.answer || '';
        const result = await qaJudge(question, expected, body.student || '');
        return respData(result);
      }
      return respErr('Unknown qa op');
    }
    if (action === 'similar') {
      // 生成类似题
      const card = body.cardId ? await getCard(user.id, body.cardId) : null;
      if (!card) return respErr('Card not found');
      const result = await generateSimilar(card);
      if (!result) return respErr('AI 不可用，无法生成类似题');
      return respData(result);
    }
    if (action === 'practice') {
      // 练习题：op = create | list | answer | delete
      const op = body.op || url.searchParams.get('op') || 'list';
      if (op === 'create') {
        const result = await createPractice(user.id, body.cardId);
        if (!result) return respErr('生成失败（AI 不可用或卡片不存在）');
        return respData(result);
      }
      if (op === 'answer') {
        const result = await answerPractice(
          user.id,
          body.practiceId,
          body.studentAnswer || ''
        );
        return respData(result);
      }
      if (op === 'delete') {
        await deletePractice(user.id, body.practiceId);
        return respData({ ok: true });
      }
      // list
      const subject =
        body.subject || url.searchParams.get('subject') || undefined;
      return respData(await listPractice(user.id, subject));
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
