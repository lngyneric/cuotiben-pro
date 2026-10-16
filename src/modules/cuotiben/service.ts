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
  return db()
    .select()
    .from(cuotibenCard)
    .where(where)
    .orderBy(desc(cuotibenCard.createdAt));
}

export async function getCard(userId: string, cardId: string) {
  const rows = await db()
    .select()
    .from(cuotibenCard)
    .where(and(eq(cuotibenCard.userId, userId), eq(cuotibenCard.id, cardId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createCard(
  userId: string,
  data: Omit<NewCuotibenCard, 'id' | 'userId' | 'createdAt'>
) {
  const id = getUuid();
  await db()
    .insert(cuotibenCard)
    .values({
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
  await db()
    .update(cuotibenCard)
    .set(data)
    .where(and(eq(cuotibenCard.userId, userId), eq(cuotibenCard.id, cardId)));
}

export async function deleteCard(userId: string, cardId: string) {
  await db()
    .delete(cuotibenCard)
    .where(and(eq(cuotibenCard.userId, userId), eq(cuotibenCard.id, cardId)));
  // 清理关联的 SRS 和日志
  await db()
    .delete(cuotibenSrs)
    .where(and(eq(cuotibenSrs.userId, userId), eq(cuotibenSrs.cardId, cardId)));
}

// ─── QA Log ──────────────────────────────────────────────────────────────────

export async function logAttempt(
  userId: string,
  cardId: string,
  kind: string,
  ok: boolean,
  skip = false
) {
  await db().insert(cuotibenQaLog).values({
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
  const rows = await db()
    .select()
    .from(cuotibenQaLog)
    .where(and(eq(cuotibenQaLog.userId, userId), lte(since, cuotibenQaLog.ts)));
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
  const rows = await db()
    .select()
    .from(cuotibenSrs)
    .where(and(eq(cuotibenSrs.userId, userId), eq(cuotibenSrs.cardId, cardId)))
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
    await db()
      .update(cuotibenSrs)
      .set({ ivl, ease, due, reps })
      .where(
        and(eq(cuotibenSrs.userId, userId), eq(cuotibenSrs.cardId, cardId))
      );
  } else {
    await db()
      .insert(cuotibenSrs)
      .values({ userId, cardId, ivl, ease, due, reps });
  }
}

/** 到期的卡片（SRS due <= now，或从未学过的卡） */
export async function getDueCards(userId: string, subject?: string) {
  const cards = await listCards(userId, subject);
  const srsRows = await db()
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
  const debug: any = {
    userId,
    seedLen: 0,
    existing: -1,
    imported: 0,
    error: null,
  };
  try {
    debug.seedLen = (seedData as any[])?.length || 0;
    const existing = await listCards(userId);
    debug.existing = existing.length;
    if (existing.length > 0) {
      (globalThis as any).__seedDebug = debug;
      return 0;
    }
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
      debug.imported++;
    }
  } catch (e: any) {
    debug.error = e?.message || String(e);
  }
  (globalThis as any).__seedDebug = debug;
  return debug.imported;
}

export function getSeedDebug() {
  return (globalThis as any).__seedDebug || null;
}

// ─── 问答 (QA) ───────────────────────────────────────────────────────────────
// 接口已就绪：POST /api/cuotiben { action:'qa', op:'approaches'|'judge'|'hint'|'followup', ... }
// 当前为 MOCK 实现（无 Workers AI binding）。接入 Workers AI 时替换函数体：
//   approaches / hint / followup → @cf/meta/llama-3.3-70b-instruct-fp8-fast
//   judge                      → @cf/cloudflare/clef-flash

export type QaOption = { text: string; correct: boolean };

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function isMathCard(card: { subject: string }) {
  return /数学|math/i.test(card.subject || '');
}

type QaCardInput = {
  question: string;
  answer: string;
  principle: string;
  myAnswer: string;
  subject: string;
  tag: string;
};

/** 数学卡：生成 4 个解题思路选项（1 正确 + 3 干扰项），并附一条概念追问 */
export async function qaApproaches(
  card: QaCardInput
): Promise<{ options: QaOption[]; followup: string }> {
  const correctText =
    card.principle?.trim() || card.answer?.trim() || '按标准步骤求解';
  const distractors: string[] = [];
  if (
    card.myAnswer &&
    card.myAnswer.trim() &&
    card.myAnswer.trim() !== card.answer?.trim()
  ) {
    // 原版做法：干扰项取自孩子原来的错答
    distractors.push(`像上次一样：${card.myAnswer.trim().slice(0, 90)}`);
  }
  distractors.push(
    '先把题目里的数直接代入公式算出结果，最后再处理单位或误差',
    '凭感觉选一个看起来合理的答案，不用严格按步骤推导',
    '只看题目最后问什么，跳过中间的条件限制直接作答'
  );
  const options = shuffle([
    { text: correctText, correct: true },
    ...distractors.slice(0, 3).map((text) => ({ text, correct: false })),
  ]);
  return { options, followup: qaFollowupText(card) };
}

/** 概念追问（mock：按知识点标签生成通用追问） */
export function qaFollowupText(
  card: Pick<QaCardInput, 'tag' | 'subject'>
): string {
  const tag = card.tag?.trim() || '这个知识点';
  return `关于「${tag}」，请用自己的话说说这道题考查的核心概念是什么？`;
}

export async function qaFollowup(
  card: Pick<QaCardInput, 'tag' | 'subject'>
): Promise<{ followup: string }> {
  return { followup: qaFollowupText(card) };
}

/** 提示（mock：直接给原理；原版按 attempt 渐进生成） */
export async function qaHint(
  card: Pick<QaCardInput, 'principle'>,
  _student: string,
  _attempt: number
): Promise<{ hint: string }> {
  return {
    hint: card.principle?.trim() || '再读一遍题目，把已知条件一个一个列出来。',
  };
}

/** 判分（mock：关键词重合度启发式；中文按字/词重合计算） */
export async function qaJudge(
  expected: string,
  student: string
): Promise<{ correct: boolean; confidence: number }> {
  const tokens = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0);
  const expTokens = tokens(expected);
  const stuTokens = tokens(student);
  if (!stuTokens.length || !expTokens.length)
    return { correct: false, confidence: 0 };
  const expSet = new Set(expTokens);
  let hit = 0;
  for (const w of stuTokens) {
    if (expSet.has(w)) {
      hit++;
      continue;
    }
    // 中文无空格：子串包含也算命中
    for (const e of expSet) {
      if (e.length > 1 && (e.includes(w) || w.includes(e))) {
        hit++;
        break;
      }
    }
  }
  const ratio = hit / stuTokens.length;
  return { correct: ratio >= 0.5, confidence: Math.round(ratio * 100) / 100 };
}
