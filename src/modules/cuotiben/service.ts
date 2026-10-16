import { and, desc, eq, lte } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  cuotibenCard,
  cuotibenQaLog,
  cuotibenSrs,
  type NewCuotibenCard,
} from '@/config/db/schema';
import { getUuid } from '@/lib/hash';
import { seedData } from './seed-data';

// ─── Cards ───────────────────────────────────────────────────────────────────

export async function listCards(userId: string, subject?: string) {
  const where = subject
    ? and(eq(cuotibenCard.userId, userId), eq(cuotibenCard.subject, subject))
    : eq(cuotibenCard.userId, userId);
  return db
    .select()
    .from(cuotibenCard)
    .where(where)
    .orderBy(desc(cuotibenCard.createdAt));
}

export async function getCard(userId: string, cardId: string) {
  const rows = await db
    .select()
    .from(cuotibenCard)
    .where(
      and(eq(cuotibenCard.userId, userId), eq(cuotibenCard.id, cardId))
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createCard(
  userId: string,
  data: Omit<NewCuotibenCard, 'id' | 'userId' | 'createdAt'>
) {
  const id = getUuid();
  await db.insert(cuotibenCard).values({
    id,
    userId,
    ...data,
  });
  return id;
}

export async function updateCard(
  userId: string,
  cardId: string,
  data: Partial<Omit<NewCuotibenCard, 'id' | 'userId'>>
) {
  await db
    .update(cuotibenCard)
    .set(data)
    .where(
      and(eq(cuotibenCard.userId, userId), eq(cuotibenCard.id, cardId))
    );
}

export async function deleteCard(userId: string, cardId: string) {
  await db
    .delete(cuotibenCard)
    .where(
      and(eq(cuotibenCard.userId, userId), eq(cuotibenCard.id, cardId))
    );
  // 清理关联的 SRS 和日志
  await db
    .delete(cuotibenSrs)
    .where(
      and(eq(cuotibenSrs.userId, userId), eq(cuotibenSrs.cardId, cardId))
    );
}

// ─── QA Log ──────────────────────────────────────────────────────────────────

export async function logAttempt(
  userId: string,
  cardId: string,
  kind: string,
  ok: boolean,
  skip = false
) {
  await db.insert(cuotibenQaLog).values({
    id: getUuid(),
    userId,
    cardId,
    kind,
    ok,
    skip,
    ts: new Date(),
  });
  // 同步更新 SRS
  await updateSrs(userId, cardId, ok, skip);
}

export async function getStats(userId: string, since: Date) {
  const rows = await db
    .select()
    .from(cuotibenQaLog)
    .where(
      and(
        eq(cuotibenQaLog.userId, userId),
        lte(since, cuotibenQaLog.ts)
      )
    );
  const total = rows.length;
  const correct = rows.filter((r) => r.ok && !r.skip).length;
  const skipped = rows.filter((r) => r.skip).length;
  return { total, correct, skipped, rate: total ? correct / total : 0 };
}

// ─── SRS (艾宾浩斯) ──────────────────────────────────────────────────────────

const DAY = 86400000;

export async function updateSrs(
  userId: string,
  cardId: string,
  ok: boolean,
  skip: boolean
) {
  const now = Date.now();
  const rows = await db
    .select()
    .from(cuotibenSrs)
    .where(
      and(eq(cuotibenSrs.userId, userId), eq(cuotibenSrs.cardId, cardId))
    )
    .limit(1);
  const cur = rows[0];

  let ivl = 1;
  let ease = 250;
  let reps = 0;

  if (cur) {
    ivl = cur.ivl;
    ease = cur.ease;
    reps = cur.reps;
  }

  if (skip) {
    // 跳过：明天重来，不重置进度
  } else if (ok) {
    reps += 1;
    if (reps === 1) ivl = 1;
    else if (reps === 2) ivl = 3;
    else ivl = Math.round(ivl * (ease / 100));
    ease = Math.min(300, ease + 10);
  } else {
    reps = 0;
    ivl = 1;
    ease = Math.max(130, ease - 20);
  }

  const due = new Date(now + ivl * DAY);

  if (cur) {
    await db
      .update(cuotibenSrs)
      .set({ ivl, ease, due, reps })
      .where(
        and(eq(cuotibenSrs.userId, userId), eq(cuotibenSrs.cardId, cardId))
      );
  } else {
    await db.insert(cuotibenSrs).values({ userId, cardId, ivl, ease, due, reps });
  }
}

/** 到期的卡片（SRS due <= now，或从未学过的卡） */
export async function getDueCards(userId: string, subject?: string) {
  const cards = await listCards(userId, subject);
  const srsRows = await db
    .select()
    .from(cuotibenSrs)
    .where(eq(cuotibenSrs.userId, userId));
  const srsMap = new Map(srsRows.map((s) => [s.cardId, s]));
  const now = Date.now();

  return cards.filter((c) => {
    if (c.mastered) return false;
    const s = srsMap.get(c.id);
    if (!s) return true; // 从未学过
    return new Date(s.due).getTime() <= now;
  });
}

// ─── 种子卡导入 ──────────────────────────────────────────────────────────────

export async function seedCards(userId: string) {
  // 检查是否已导入
  const existing = await listCards(userId);
  if (existing.length > 0) return 0;

  let count = 0;
  for (const c of seedData as any[]) {
    await createCard(userId, {
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
  return count;
}
