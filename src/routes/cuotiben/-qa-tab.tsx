// 问答 tab：选卡 → 完整问答流程
// Math/数学：题目 → 4 思路选项 → 选择 → 判分 → 提示 → 追问 → 回答 → 判分
// Science：题目 → 自由作答 → 判分 → 提示 → 追问 → 回答 → 判分
// 后端为 MOCK 实现（见 service.ts 注释），接口已留好
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

import { apiPost } from '@/lib/api-client';
import { m } from '@/paraglide/messages.js';

import type { Card, QaOption } from './-types';
import { isMath, safeDiagram } from './-util';

type Step = 'idle' | 'approaches' | 'answer' | 'followup' | 'done';

async function qaApi<T>(
  op: string,
  payload: Record<string, unknown>
): Promise<T> {
  return apiPost<T>('/api/cuotiben', { action: 'qa', op, ...payload });
}

export function QaTab({
  cards,
  log,
}: {
  cards: Card[];
  log: (v: {
    cardId: string;
    kind: string;
    ok: boolean;
    skip?: boolean;
  }) => void;
}) {
  const [cardId, setCardId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('idle');
  const [attempts, setAttempts] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [showCorrect, setShowCorrect] = useState(false);
  const [input, setInput] = useState('');
  const [feed, setFeed] = useState<string | null>(null);
  const [feedOk, setFeedOk] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [followup, setFollowup] = useState('');
  const [busy, setBusy] = useState(false);
  const [answerShown, setAnswerShown] = useState(false);

  const card = cards.find((c) => c.id === cardId) ?? null;
  const math = card ? isMath(card) : false;

  const approachesQ = useQuery({
    queryKey: ['qa-approaches', card?.id],
    queryFn: () =>
      qaApi<{ mock: boolean; options: QaOption[]; followup: string }>(
        'approaches',
        {
          cardId: card!.id,
        }
      ),
    enabled: step === 'approaches' && math && !!card,
    staleTime: Infinity,
  });
  const options = approachesQ.data?.options ?? [];
  const correctIdx = options.findIndex((o) => o.correct);

  const reset = () => {
    setAttempts(0);
    setPicked(null);
    setShowCorrect(false);
    setInput('');
    setFeed(null);
    setHint(null);
    setFollowup('');
    setBusy(false);
    setAnswerShown(false);
  };

  const start = (c: Card) => {
    reset();
    setCardId(c.id);
    setStep(isMath(c) ? 'approaches' : 'answer');
  };

  const close = () => {
    setCardId(null);
    setStep('idle');
    reset();
  };

  const skip = () => {
    if (card) log({ cardId: card.id, kind: step, ok: false, skip: true });
    setStep('done');
  };

  // --- 数学：选思路 ---
  const pick = (i: number) => {
    if (!card || picked !== null || busy) return;
    const opt = options[i];
    setPicked(i);
    log({ cardId: card.id, kind: 'approach', ok: opt.correct });
    if (opt.correct) {
      setFeed(m['cuotiben.qa_approach_correct']());
      setFeedOk(true);
      setFollowup(approachesQ.data?.followup ?? '');
      setStep('followup');
    } else {
      const n = attempts + 1;
      setAttempts(n);
      setFeed(m['cuotiben.qa_approach_wrong']());
      setFeedOk(false);
      if (n >= 2) setShowCorrect(true);
    }
  };

  const revealApproach = () => {
    setShowCorrect(true);
    setFollowup(approachesQ.data?.followup ?? '');
    setStep('followup');
  };

  // --- 科学：自由作答 ---
  const submitAnswer = async () => {
    if (!card || busy) return;
    const v = input.trim();
    if (!v) {
      toast.error(m['cuotiben.qa_need_answer']());
      return;
    }
    setBusy(true);
    try {
      const r = await qaApi<{ mock: boolean; correct: boolean }>('judge', {
        cardId: card.id,
        student: v,
      });
      log({ cardId: card.id, kind: 'answer', ok: r.correct });
      if (r.correct) {
        const f = await qaApi<{ mock: boolean; followup: string }>('followup', {
          cardId: card.id,
        });
        setFollowup(f.followup);
        setFeed(m['cuotiben.qa_correct']());
        setFeedOk(true);
        setInput('');
        setStep('followup');
      } else {
        const n = attempts + 1;
        setAttempts(n);
        setFeed(m['cuotiben.qa_wrong']());
        setFeedOk(false);
      }
    } catch (e: any) {
      toast.error(e.message);
    }
    setBusy(false);
  };

  // --- 追问作答 ---
  const submitFollowup = async () => {
    if (!card || busy) return;
    const v = input.trim();
    if (!v) {
      toast.error(m['cuotiben.qa_need_answer']());
      return;
    }
    setBusy(true);
    try {
      const r = await qaApi<{ mock: boolean; correct: boolean }>('judge', {
        cardId: card.id,
        expected: card.answer,
        student: `${followup} ${v}`,
      });
      log({ cardId: card.id, kind: 'followup', ok: r.correct });
      if (r.correct) {
        setFeed(m['cuotiben.qa_followup_correct']());
        setFeedOk(true);
        setStep('done');
      } else {
        setFeed(m['cuotiben.qa_followup_wrong']());
        setFeedOk(false);
      }
    } catch (e: any) {
      toast.error(e.message);
    }
    setBusy(false);
  };

  const fetchHint = async () => {
    if (!card || busy) return;
    setBusy(true);
    try {
      const r = await qaApi<{ mock: boolean; hint: string }>('hint', {
        cardId: card.id,
        student: input,
        attempt: attempts,
      });
      setHint(r.hint);
    } catch (e: any) {
      toast.error(e.message);
    }
    setBusy(false);
  };

  // --- 选卡界面 ---
  if (!card || step === 'idle') {
    const sorted = [...cards].sort(
      (a, b) => Number(a.mastered) - Number(b.mastered)
    );
    return (
      <div>
        <p className="mb-3 text-sm text-slate-500">
          {m['cuotiben.qa_pick_hint']()}
        </p>
        <div className="space-y-2">
          {sorted.map((c) => (
            <button
              key={c.id}
              onClick={() => start(c)}
              className="block w-full rounded-xl bg-white p-3 text-left shadow-sm"
            >
              <div className="mb-1 flex gap-1">
                <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                  {c.subject}
                </span>
                {c.tag && (
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                    {c.tag}
                  </span>
                )}
                {c.mastered && (
                  <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
                    {m['cuotiben.badge_mastered']()}
                  </span>
                )}
              </div>
              <div className="line-clamp-2 text-sm">{c.question}</div>
            </button>
          ))}
          {sorted.length === 0 && (
            <div className="py-10 text-center text-slate-500">
              {m['cuotiben.empty_cards']()}
            </div>
          )}
        </div>
      </div>
    );
  }

  const diagram = safeDiagram(card.diagram);

  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <h3 className="mb-2 font-bold">{m['cuotiben.qa_title']()}</h3>
      {diagram && (
        <div
          className="mb-2 text-center"
          dangerouslySetInnerHTML={{ __html: diagram }}
        />
      )}
      <div className="mb-4 font-medium whitespace-pre-wrap">
        {card.question}
      </div>
      <div className="mb-1 text-xs text-slate-400">
        {m['cuotiben.qa_mock_note']()}
      </div>

      {step === 'approaches' && (
        <div>
          <div className="mb-2 text-sm font-bold">
            {m['cuotiben.qa_choose_approach']()}
          </div>
          {approachesQ.isLoading && (
            <div className="text-sm text-slate-500">
              {m['cuotiben.loading']()}
            </div>
          )}
          {options.map((o, i) => {
            const isPicked = picked === i;
            const isCorrectOpt = i === correctIdx;
            let cls = 'border-slate-200 bg-slate-50';
            if (picked !== null) {
              if (isCorrectOpt && showCorrect)
                cls = 'border-green-500 bg-green-50';
              else if (isPicked) cls = 'border-red-500 bg-red-50';
              else cls = 'border-slate-200 bg-slate-50 opacity-70';
            }
            return (
              <button
                key={i}
                disabled={picked !== null}
                onClick={() => pick(i)}
                className={`mb-2 block w-full rounded-lg border-2 p-3 text-left text-sm ${cls}`}
              >
                {o.text}
              </button>
            );
          })}
          {picked !== null && !options[picked]?.correct && !showCorrect && (
            <button
              onClick={() => setPicked(null)}
              className="text-sm font-bold text-blue-600"
            >
              {m['cuotiben.qa_retry']()}
            </button>
          )}
          {showCorrect && correctIdx >= 0 && (
            <div className="mt-2 rounded-lg border-l-4 border-green-500 bg-green-50 p-2 text-sm">
              ✅ {m['cuotiben.qa_correct_approach']()}：
              {options[correctIdx].text}
            </div>
          )}
          {attempts >= 2 && !showCorrect && (
            <button
              onClick={revealApproach}
              className="mt-2 rounded-lg bg-slate-200 px-4 py-2 text-sm"
            >
              {m['cuotiben.qa_show_correct']()}
            </button>
          )}
        </div>
      )}

      {step === 'answer' && (
        <div>
          <div className="mb-2 text-sm font-bold">
            {m['cuotiben.qa_answer_prompt']()}
          </div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={m['cuotiben.qa_answer_placeholder']()}
            className="mb-2 min-h-[90px] w-full rounded-lg border p-2"
          />
          <div className="flex gap-2">
            <button
              onClick={submitAnswer}
              disabled={busy}
              className="min-h-[44px] flex-1 rounded-lg bg-blue-600 text-white disabled:opacity-50"
            >
              {busy ? m['cuotiben.qa_judging']() : m['cuotiben.qa_submit']()}
            </button>
            <button
              onClick={fetchHint}
              disabled={busy}
              className="min-h-[44px] rounded-lg bg-amber-100 px-4 text-amber-800 disabled:opacity-50"
            >
              {m['cuotiben.qa_hint_btn']()}
            </button>
          </div>
          {hint && (
            <div className="mt-2 rounded-lg border-l-4 border-amber-500 bg-amber-50 p-2 text-sm whitespace-pre-wrap">
              💡 {hint}
            </div>
          )}
          {card.principle && feed && !feedOk && (
            <div className="mt-2 rounded-lg border-l-4 border-amber-500 bg-amber-50 p-2 text-sm whitespace-pre-wrap">
              💡 {card.principle}
            </div>
          )}
          {attempts >= 2 && !answerShown && (
            <button
              onClick={() => setAnswerShown(true)}
              className="mt-2 rounded-lg bg-slate-200 px-4 py-2 text-sm"
            >
              {m['cuotiben.qa_show_answer']()}
            </button>
          )}
          {answerShown && (
            <div className="mt-2 rounded-lg bg-slate-50 p-3 text-sm whitespace-pre-wrap">
              ✅ {card.answer}
            </div>
          )}
        </div>
      )}

      {step === 'followup' && (
        <div className="mt-2 border-t pt-3">
          <div className="mb-2 text-sm font-bold">
            {m['cuotiben.qa_followup_title']()}：{followup}
          </div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={m['cuotiben.qa_followup_placeholder']()}
            className="mb-2 min-h-[70px] w-full rounded-lg border p-2"
          />
          <div className="flex gap-2">
            <button
              onClick={submitFollowup}
              disabled={busy}
              className="min-h-[44px] flex-1 rounded-lg bg-blue-600 text-white disabled:opacity-50"
            >
              {busy ? m['cuotiben.qa_judging']() : m['cuotiben.qa_submit']()}
            </button>
            <button
              onClick={fetchHint}
              disabled={busy}
              className="min-h-[44px] rounded-lg bg-amber-100 px-4 text-amber-800 disabled:opacity-50"
            >
              {m['cuotiben.qa_hint_btn']()}
            </button>
          </div>
          {hint && (
            <div className="mt-2 rounded-lg border-l-4 border-amber-500 bg-amber-50 p-2 text-sm whitespace-pre-wrap">
              💡 {hint}
            </div>
          )}
        </div>
      )}

      {feed && step !== 'done' && (
        <div
          className={`mt-3 rounded-lg p-2 text-sm font-bold ${
            feedOk ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
          }`}
        >
          {feed}
        </div>
      )}

      {step === 'done' && (
        <div className="mt-3 rounded-lg bg-green-50 p-4 text-center font-bold text-green-700">
          {m['cuotiben.qa_done']()}
        </div>
      )}

      <div className="mt-4 flex gap-2">
        {step !== 'done' && (
          <button
            onClick={skip}
            className="min-h-[44px] flex-1 rounded-lg bg-amber-100 text-amber-800"
          >
            {m['cuotiben.btn_skip']()}
          </button>
        )}
        <button
          onClick={close}
          className="min-h-[44px] flex-1 rounded-lg bg-slate-200 text-slate-700"
        >
          {m['cuotiben.qa_close']()}
        </button>
      </div>
    </div>
  );
}
