import { and, desc, eq, lte } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  cuotibenCard,
  cuotibenPractice,
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
// Workers AI 接入：
//   approaches / hint / followup / similar → @cf/meta/llama-3.3-70b-instruct-fp8-fast
//   judge                                → @cf/cloudflare/clef-flash
// 无 AI binding 时自动降级为 MOCK。

const LLAMA_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const JUDGE_MODEL = '@cf/cloudflare/clef-flash';

function getAI(): any | null {
  try {
    const env = (globalThis as any).__CF_ENV__;
    return env?.AI || null;
  } catch {
    return null;
  }
}

function aiText(out: any): string {
  if (!out) return '';
  if (typeof out.response === 'string') return out.response;
  if (out.choices?.[0]?.message?.content) return out.choices[0].message.content;
  if (typeof out.result === 'string') return out.result;
  if (typeof out === 'string') return out;
  return '';
}

function cleanJson(txt: string): string {
  return String(txt)
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/, '');
}

function detectLang(q: string, s: string): string {
  return /[\u4e00-\u9fff]/.test(q + s) ? '中文' : 'English';
}

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
): Promise<{ options: QaOption[]; followup: string; mock: boolean }> {
  const ai = getAI();
  if (ai) {
    try {
      const lang = detectLang(card.question, card.subject);
      const sysA =
        '你是初中老师，擅长设计选择题干扰项。严格只返回 JSON，不要输出任何解释文字。';
      const prompt =
        `题目：${card.question}\n` +
        `正确答案思路：${card.principle || card.answer}\n` +
        `学生上次的错误：${card.myAnswer || '无'}\n` +
        `请用${lang}生成 4 个解题思路选项（1 个正确 + 3 个干扰项，干扰项要像学生常犯的错误）。\n` +
        `返回 JSON：{"options":[{"text":"...","correct":true},...],"followup":"一条概念追问"}`;
      const out = await ai.run(LLAMA_MODEL, {
        messages: [
          { role: 'system', content: sysA },
          { role: 'user', content: prompt },
        ],
      });
      const parsed = JSON.parse(cleanJson(aiText(out)));
      if (parsed.options?.length >= 2) {
        return {
          options: shuffle(parsed.options),
          followup: parsed.followup || qaFollowupText(card),
          mock: false,
        };
      }
    } catch {
      // 降级到 MOCK
    }
  }
  // MOCK 降级
  const correctText =
    card.principle?.trim() || card.answer?.trim() || '按标准步骤求解';
  const distractors: string[] = [];
  if (
    card.myAnswer &&
    card.myAnswer.trim() &&
    card.myAnswer.trim() !== card.answer?.trim()
  ) {
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
  return { options, followup: qaFollowupText(card), mock: true };
}

/** 概念追问 */
export function qaFollowupText(
  card: Pick<QaCardInput, 'tag' | 'subject'>
): string {
  const tag = card.tag?.trim() || '这个知识点';
  return `关于「${tag}」，请用自己的话说说这道题考查的核心概念是什么？`;
}

export async function qaFollowup(
  card: Pick<QaCardInput, 'tag' | 'subject' | 'question' | 'principle'>
): Promise<{ followup: string; mock: boolean }> {
  const ai = getAI();
  if (ai) {
    try {
      const lang = detectLang((card as any).question || '', card.subject || '');
      const out = await ai.run(LLAMA_MODEL, {
        messages: [
          {
            role: 'system',
            content: '你是初中老师。只返回一条概念追问，不要解释。',
          },
          {
            role: 'user',
            content: `知识点：${card.tag}\n题目：${(card as any).question || ''}\n原理：${(card as any).principle || ''}\n请用${lang}生成一条概念追问，引导学生说出核心概念。`,
          },
        ],
      });
      const text = aiText(out).trim();
      if (text) return { followup: text, mock: false };
    } catch {
      // 降级
    }
  }
  return { followup: qaFollowupText(card), mock: true };
}

/** 提示（按 attempt 渐进：第一次给方向，第二次给关键步骤） */
export async function qaHint(
  card: Pick<QaCardInput, 'principle' | 'question'>,
  _student: string,
  attempt: number
): Promise<{ hint: string; mock: boolean }> {
  const ai = getAI();
  if (ai) {
    try {
      const lang = detectLang((card as any).question || '', '');
      const level =
        attempt <= 1
          ? '只给思考方向，不要给具体步骤'
          : '给出关键的一步，但不要给完整答案';
      const out = await ai.run(LLAMA_MODEL, {
        messages: [
          {
            role: 'system',
            content: '你是初中老师，擅长启发式提示。只返回提示，不要给答案。',
          },
          {
            role: 'user',
            content: `题目：${(card as any).question || ''}\n原理：${card.principle || ''}\n学生第 ${attempt} 次尝试失败。请用${lang}给一个提示（${level}）。`,
          },
        ],
      });
      const text = aiText(out).trim();
      if (text) return { hint: text, mock: false };
    } catch {
      // 降级
    }
  }
  return {
    hint: card.principle?.trim() || '再读一遍题目，把已知条件一个一个列出来。',
    mock: true,
  };
}

/** 判分（Clef-flash；无 AI 时降级为关键词启发式） */
export async function qaJudge(
  question: string,
  expected: string,
  student: string
): Promise<{ correct: boolean; confidence: number; mock: boolean }> {
  const ai = getAI();
  if (ai) {
    try {
      const out = await ai.run(JUDGE_MODEL, {
        model: 'clef-flash',
        state: `Question: ${question}\nExpected answer: ${expected}\nStudent answer: ${student}`,
        questions: {
          verdict: {
            type: 'choice',
            instructions:
              'Is the student answer correct? Judge strictly but fairly.',
            criteria: {
              correct:
                'The student answer captures the key points or meaning of the expected answer (wording may differ, language may differ)',
              incorrect:
                'The student answer is wrong, contradicts the expected answer, or misses the key points',
            },
          },
        },
      });
      const verdict = out?.answers?.verdict;
      const choice = verdict?.choice || verdict?.route || '';
      const conf = verdict?.confidence ?? 0.5;
      return {
        correct: /correct/i.test(choice) && !/incorrect/i.test(choice),
        confidence: Math.round(conf * 100) / 100,
        mock: false,
      };
    } catch {
      // 降级到关键词启发式
    }
  }
  // MOCK 降级：关键词重合度
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
  return {
    correct: ratio >= 0.5,
    confidence: Math.round(ratio * 100) / 100,
    mock: true,
  };
}

/** 生成类似题（Llama；无 AI 时返回 null） */
export async function generateSimilar(
  card: QaCardInput
): Promise<{ question: string; answer: string; mock: boolean } | null> {
  const ai = getAI();
  if (!ai) return null;
  try {
    const lang = detectLang(card.question, card.subject);
    const out = await ai.run(LLAMA_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            '你是初中老师，擅长出同类练习题。严格只返回 JSON，不要输出解释。',
        },
        {
          role: 'user',
          content:
            `原题：${card.question}\n` +
            `答案：${card.answer}\n` +
            `原理：${card.principle}\n` +
            `请用${lang}出一道同类型、同难度的练习题（换数字/换场景，不要重复原题）。\n` +
            `返回 JSON：{"question":"...","answer":"..."}`,
        },
      ],
    });
    const parsed = JSON.parse(cleanJson(aiText(out)));
    if (parsed.question) {
      return {
        question: parsed.question,
        answer: parsed.answer || '',
        mock: false,
      };
    }
  } catch {
    // 忽略
  }
  return null;
}

// ─── AI 练习题（独立掌握情况） ───────────────────────────────────────────────

/** 从错题生成练习题并入库 */
export async function createPractice(
  userId: string,
  cardId: string
): Promise<{ id: string; question: string } | null> {
  const card = await getCard(userId, cardId);
  if (!card) return null;
  const gen = await generateSimilar(card);
  if (!gen) return null;
  const id = `pr-${getUuid().slice(0, 8)}`;
  await db()
    .insert(cuotibenPractice)
    .values({
      id,
      userId,
      cardId,
      subject: card.subject || '',
      tag: card.tag || '',
      question: gen.question,
      answer: gen.answer,
      principle: card.principle || '',
    });
  return { id, question: gen.question };
}

/** 练习题列表 */
export async function listPractice(userId: string, subject?: string) {
  const conds = [eq(cuotibenPractice.userId, userId)];
  if (subject) conds.push(eq(cuotibenPractice.subject, subject));
  return db()
    .select()
    .from(cuotibenPractice)
    .where(and(...conds))
    .orderBy(desc(cuotibenPractice.createdAt));
}

/** 练习题答题：AI 判分，更新掌握情况（独立于错题卡） */
export async function answerPractice(
  userId: string,
  practiceId: string,
  studentAnswer: string
): Promise<{
  correct: boolean;
  confidence: number;
  mock: boolean;
  mastered: boolean;
}> {
  const rows = await db()
    .select()
    .from(cuotibenPractice)
    .where(
      and(
        eq(cuotibenPractice.id, practiceId),
        eq(cuotibenPractice.userId, userId)
      )
    );
  const p = rows[0];
  if (!p) throw new Error('Practice not found');
  const { correct, confidence, mock } = await qaJudge(
    p.question,
    p.answer,
    studentAnswer
  );
  const attempts = (p.attempts || 0) + 1;
  const correctCount = (p.correctCount || 0) + (correct ? 1 : 0);
  // 连续答对 2 次算掌握
  const mastered = correctCount >= 2;
  await db()
    .update(cuotibenPractice)
    .set({ attempts, correctCount, mastered })
    .where(eq(cuotibenPractice.id, practiceId));
  return { correct, confidence, mock, mastered };
}

/** 删除练习题 */
export async function deletePractice(userId: string, practiceId: string) {
  await db()
    .delete(cuotibenPractice)
    .where(
      and(
        eq(cuotibenPractice.id, practiceId),
        eq(cuotibenPractice.userId, userId)
      )
    );
}
