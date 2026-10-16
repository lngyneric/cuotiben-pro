// 学习 tab：SRS 到期队列 + 今日统计
// 答对 1→3→8…天，答错/跳过次日重来（后端 updateSrs）
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { apiGet } from '@/lib/api-client';
import { m } from '@/paraglide/messages.js';

import { DUE_KEY, STATS_KEY, type Card, type Stats } from './-types';
import { safeDiagram } from './-util';

export function StudyTab({
  subject,
  log,
}: {
  subject: string;
  log: (v: {
    cardId: string;
    kind: string;
    ok: boolean;
    skip?: boolean;
  }) => void;
}) {
  const dueQ = useQuery({
    queryKey: DUE_KEY,
    queryFn: () => apiGet<Card[]>('/api/cuotiben?action=due'),
  });
  const statsQ = useQuery({
    queryKey: STATS_KEY,
    queryFn: () => apiGet<Stats>('/api/cuotiben?action=stats&days=1'),
  });

  const [sIdx, setSIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);

  const due = useMemo(() => {
    const all = dueQ.data ?? [];
    return subject === '全部' ? all : all.filter((c) => c.subject === subject);
  }, [dueQ.data, subject]);

  const stats = statsQ.data ?? { total: 0, correct: 0, skipped: 0, rate: 0 };
  const acc = stats.total ? Math.round((stats.correct / stats.total) * 100) : 0;

  const answer = (ok: boolean, skip = false) => {
    const card = due[sIdx];
    if (!card) return;
    log({ cardId: card.id, kind: 'review', ok, skip });
    setRevealed(false);
    setSIdx(sIdx + 1);
  };

  const done = sIdx >= due.length;
  const card = due[sIdx];
  const diagram = card ? safeDiagram(card.diagram) : null;

  return (
    <div>
      <div className="mb-3 rounded-xl bg-white p-4 shadow-sm">
        <h3 className="mb-2 font-bold">{m['cuotiben.study_today_plan']()}</h3>
        <div className="text-[15px]">
          {m['cuotiben.study_due_today']({ n: Math.max(0, due.length - sIdx) })}
        </div>
        {done ? (
          <div className="mt-2 font-medium text-green-700">
            {m['cuotiben.study_done']()}
          </div>
        ) : (
          <div className="mt-2 max-h-44 space-y-1 overflow-auto text-sm">
            {due.slice(sIdx, sIdx + 10).map((c) => (
              <div key={c.id} className="border-b border-slate-100 py-1">
                • {(c.question || '').slice(0, 42)}…
                <span className="ml-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                  {c.subject}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {!done && card && (
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-1 text-sm text-slate-500">
            {sIdx + 1} / {due.length} · {card.subject} · {card.tag}
          </div>
          <div className="mb-4 text-lg font-medium whitespace-pre-wrap">
            {card.question}
          </div>
          {diagram && (
            <div
              className="mb-4 text-center"
              dangerouslySetInnerHTML={{ __html: diagram }}
            />
          )}
          {!revealed ? (
            <button
              onClick={() => setRevealed(true)}
              className="min-h-[48px] w-full rounded-lg bg-blue-600 text-white"
            >
              {m['cuotiben.study_reveal']()}
            </button>
          ) : (
            <div>
              <div className="mb-2 rounded-lg bg-green-50 p-3 whitespace-pre-wrap">
                ✅ {card.answer}
              </div>
              {card.principle && (
                <div className="mb-4 rounded-lg bg-amber-50 p-3 text-sm whitespace-pre-wrap">
                  📌 {card.principle}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => answer(false)}
                  className="min-h-[48px] flex-1 rounded-lg bg-red-500 text-white"
                >
                  {m['cuotiben.btn_forgot']()}
                </button>
                <button
                  onClick={() => answer(true, true)}
                  className="min-h-[48px] flex-1 rounded-lg bg-amber-100 text-amber-800"
                >
                  {m['cuotiben.btn_skip']()}
                </button>
                <button
                  onClick={() => answer(true)}
                  className="min-h-[48px] flex-1 rounded-lg bg-green-600 text-white"
                >
                  {m['cuotiben.btn_remembered']()}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 rounded-xl bg-white p-4 shadow-sm">
        <h3 className="mb-2 font-bold">{m['cuotiben.study_stats']()}</h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-lg bg-slate-50 p-3">
            {m['cuotiben.stat_answered']()}
            <br />
            <b className="text-xl">{stats.total}</b>
          </div>
          <div className="rounded-lg bg-slate-50 p-3">
            {m['cuotiben.stat_rate']()}
            <br />
            <b className="text-xl">{acc}%</b>
          </div>
          <div className="rounded-lg bg-slate-50 p-3">
            {m['cuotiben.stat_skipped']()}
            <br />
            <b className="text-xl">{stats.skipped}</b>
          </div>
          <div className="rounded-lg bg-slate-50 p-3">
            {m['cuotiben.stat_total']({ n: stats.total })}
          </div>
        </div>
        <div className="mt-2 text-xs text-slate-500">
          {m['cuotiben.srs_note']()}
        </div>
      </div>
    </div>
  );
}
