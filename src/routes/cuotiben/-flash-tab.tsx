// 闪卡 tab：翻转卡片
// Math/数学卡：正面先做 4 选 1 解题思路（判对错），再翻面看答案
// Science 卡：直接翻面
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

import { apiPost } from '@/lib/api-client';
import { m } from '@/paraglide/messages.js';

import type { Card, QaOption } from './-types';
import { isMath, safeDiagram } from './-util';

export function FlashTab({
  cards,
  toggleMastered,
  log,
}: {
  cards: Card[];
  toggleMastered: (c: Card) => void;
  log: (v: {
    cardId: string;
    kind: string;
    ok: boolean;
    skip?: boolean;
  }) => void;
}) {
  const [pool, setPool] = useState<'all' | 'un'>('all');
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [showCorrect, setShowCorrect] = useState(false);

  const list = useMemo(
    () => cards.filter((c) => pool === 'all' || !c.mastered),
    [cards, pool]
  );
  const safeIdx = list.length ? idx % list.length : 0;
  const card = list[safeIdx];

  const resetCard = () => {
    setFlipped(false);
    setPicked(null);
    setAttempts(0);
    setShowCorrect(false);
  };

  // 学科/池变化时回到第一张
  useEffect(() => {
    setIdx(0);
    resetCard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, cards.length]);

  const go = (d: number) => {
    if (!list.length) return;
    setIdx((safeIdx + d + list.length) % list.length);
    resetCard();
  };

  const shuffle = () => {
    if (list.length < 2) return;
    // Fisher-Yates 后跳到随机位置：用“随机下一张”近似乱序体验
    setIdx(Math.floor(Math.random() * list.length));
    resetCard();
  };

  // 数学卡：取 4 个解题思路选项
  const approachQ = useQuery({
    queryKey: ['qa-approaches', card?.id],
    queryFn: () =>
      apiPost<{ mock: boolean; options: QaOption[]; followup: string }>(
        '/api/cuotiben',
        {
          action: 'qa',
          op: 'approaches',
          cardId: card!.id,
        }
      ),
    enabled: !!card && isMath(card),
    staleTime: Infinity,
  });
  const options = approachQ.data?.options ?? [];

  const pick = (i: number) => {
    if (!card || picked !== null) return;
    const opt = options[i];
    setPicked(i);
    log({ cardId: card.id, kind: 'approach', ok: opt.correct });
    if (opt.correct) {
      toast.success(m['cuotiben.qa_approach_correct']());
    } else {
      const n = attempts + 1;
      setAttempts(n);
      toast.error(m['cuotiben.qa_approach_wrong']());
      if (n >= 2) setShowCorrect(true);
    }
  };

  const retryPick = () => {
    setPicked(null);
  };

  if (!card) {
    return (
      <div className="py-20 text-center text-slate-500">
        {pool === 'un'
          ? m['cuotiben.flash_empty_unmastered']()
          : m['cuotiben.flash_empty']()}
      </div>
    );
  }

  const math = isMath(card);
  const diagram = safeDiagram(card.diagram);
  const correctIdx = options.findIndex((o) => o.correct);

  return (
    <div>
      <div className="mb-3 flex gap-2">
        <select
          value={pool}
          onChange={(e) => setPool(e.target.value as 'all' | 'un')}
          className="min-h-[44px] flex-1 rounded-lg border bg-white px-3"
        >
          <option value="all">{m['cuotiben.flash_all']()}</option>
          <option value="un">{m['cuotiben.flash_unmastered']()}</option>
        </select>
        <button
          onClick={shuffle}
          className="min-h-[44px] rounded-lg bg-slate-100 px-4 text-sm"
        >
          {m['cuotiben.btn_shuffle']()}
        </button>
      </div>

      <div className="mb-2 text-center text-sm text-slate-500">
        {safeIdx + 1} / {list.length}
      </div>

      <div className="fc-wrap">
        <div
          className={`fc ${flipped ? 'flip' : ''}`}
          onClick={() => setFlipped(!flipped)}
        >
          <div className="fc-in">
            <div className="fc-face">
              <div>
                {diagram && (
                  <div
                    className="mb-2 text-center"
                    dangerouslySetInnerHTML={{ __html: diagram }}
                  />
                )}
                <div className="text-lg font-semibold whitespace-pre-wrap">
                  {card.question}
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {card.src && (
                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                      {card.src}
                    </span>
                  )}
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                    {card.subject}
                  </span>
                  {card.tag && (
                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                      {card.tag}
                    </span>
                  )}
                </div>
                {math && (
                  <div className="mt-4" onClick={(e) => e.stopPropagation()}>
                    <div className="mb-2 text-sm font-bold">
                      {m['cuotiben.qa_choose_approach']()}
                    </div>
                    {approachQ.isLoading && (
                      <div className="text-sm text-slate-500">
                        {m['cuotiben.loading']()}
                      </div>
                    )}
                    {options.map((o, i) => {
                      const isPicked = picked === i;
                      const isCorrectOpt = i === correctIdx;
                      let cls = 'border-slate-200 bg-slate-50 text-slate-800';
                      if (picked !== null) {
                        if (
                          isCorrectOpt &&
                          (showCorrect || (isPicked && o.correct))
                        )
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
                    {picked !== null &&
                      !options[picked]?.correct &&
                      !showCorrect && (
                        <div className="mt-1 text-sm">
                          <span className="text-slate-500">
                            {m['cuotiben.qa_retry']()}{' '}
                          </span>
                          <button
                            onClick={retryPick}
                            className="font-bold text-blue-600"
                          >
                            ↻
                          </button>
                        </div>
                      )}
                    {showCorrect && correctIdx >= 0 && (
                      <div className="mt-2 rounded-lg border-l-4 border-green-500 bg-green-50 p-2 text-sm">
                        ✅ {m['cuotiben.qa_correct_approach']()}：
                        {options[correctIdx].text}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="fc-face fc-back">
              <div>
                <div className="rounded-r-lg border-l-4 border-blue-600 bg-slate-50 p-3 whitespace-pre-wrap">
                  ✅ {card.answer}
                </div>
                {card.principle && (
                  <div className="mt-2 text-sm whitespace-pre-wrap text-slate-600">
                    📌 {card.principle}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="mt-2 text-center text-xs text-slate-500">
        {m['cuotiben.flash_tap_hint']()}
      </div>

      <div className="mt-3 flex flex-wrap justify-center gap-2">
        <button
          onClick={() => go(-1)}
          className="min-h-[44px] rounded-lg bg-slate-100 px-4"
        >
          {m['cuotiben.btn_prev']()}
        </button>
        <button
          onClick={() => toggleMastered(card)}
          className={`min-h-[44px] rounded-lg px-4 ${
            card.mastered
              ? 'bg-slate-100 text-slate-600'
              : 'bg-green-100 text-green-700'
          }`}
        >
          ✓{' '}
          {card.mastered
            ? m['cuotiben.btn_unmaster']()
            : m['cuotiben.btn_mastered']()}
        </button>
        <button
          onClick={() => go(1)}
          className="min-h-[44px] rounded-lg bg-blue-600 px-4 text-white"
        >
          {m['cuotiben.btn_next']()}
        </button>
      </div>
    </div>
  );
}
