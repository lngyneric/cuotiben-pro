// 记事本：时间线首页。只改页面 UI，不动 API、不动数据库。
// 下线的四个 tab（闪卡 / 学习 SRS / AI 问答 / 练一练）与今日统计已移除，
// 答题记录（qa_log / srs / practice）不再展示，但库里的行全部保留。
// 未掌握的条目就是待处理的提醒事项，不用答题记录算。
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { toast } from 'sonner';

import { apiDelete, apiGet, apiPut } from '@/lib/api-client';
import { m } from '@/paraglide/messages.js';

import { TimelineTab } from './-timeline-tab';
import { CARDS_KEY, type Card } from './-types';

export const Route = createFileRoute('/cuotiben/')({
  component: NotepadPage,
});

const SUBJECTS = ['全部', 'IGMath', '上海数学', 'Science'];

// ─── 数据 hooks（TanStack Query + api-client，不用裸 fetch） ──────────────────

function useCards() {
  return useQuery({
    queryKey: CARDS_KEY,
    queryFn: () => apiGet<Card[]>('/api/cuotiben'),
  });
}

function useInvalidateCuotiben() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: CARDS_KEY });
}

function useToggleMastered() {
  const invalidate = useInvalidateCuotiben();
  return useMutation({
    mutationFn: (c: Card) =>
      apiPut('/api/cuotiben', { id: c.id, card: { mastered: !c.mastered } }),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });
}

function useDeleteCard() {
  const invalidate = useInvalidateCuotiben();
  return useMutation({
    mutationFn: (id: string) =>
      apiDelete(`/api/cuotiben?id=${encodeURIComponent(id)}`),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });
}

// ─── 主页面 ──────────────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'pending' | 'done';

function NotepadPage() {
  const [subject, setSubject] = useState('全部');
  const [status, setStatus] = useState<StatusFilter>('all');
  const cardsQ = useCards();
  const invalidate = useInvalidateCuotiben();
  const toggleMut = useToggleMastered();
  const deleteMut = useDeleteCard();

  const cards = cardsQ.data ?? [];
  const subjects = useMemo(() => {
    const extra = [
      ...new Set(cards.map((c) => c.subject).filter(Boolean)),
    ].filter((s) => !SUBJECTS.includes(s));
    return [...SUBJECTS, ...extra];
  }, [cards]);
  // 时间线：按 createdAt 倒序（API 已如此排，这里再排一次防兜底），
  // 再按科目 + 处理状态过滤。
  const filtered = useMemo(() => {
    const sorted = [...cards].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
    const bySubject =
      subject === '全部' ? sorted : sorted.filter((c) => c.subject === subject);
    if (status === 'pending') return bySubject.filter((c) => !c.mastered);
    if (status === 'done') return bySubject.filter((c) => c.mastered);
    return bySubject;
  }, [cards, subject, status]);
  const masteredCount = cards.filter((c) => c.mastered).length;
  const pendingCount = cards.length - masteredCount;

  if (cardsQ.isError) {
    return (
      <div className="mx-auto max-w-2xl p-6 text-center">
        <p className="mb-4">{m['cuotiben.need_login']()}</p>
        <a
          href="/sign-in"
          className="inline-block min-h-[48px] rounded-lg bg-blue-600 px-6 py-3 text-white"
        >
          {m['cuotiben.go_login']()}
        </a>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <header className="sticky top-0 z-10 bg-blue-600 px-4 py-3 text-white">
        <div className="mx-auto flex max-w-2xl items-center justify-between">
          <span className="text-lg font-bold">📒 {m['cuotiben.title']()}</span>
          <small className="opacity-85">
            {cards.length
              ? m['cuotiben.mastered_count']({
                  m: masteredCount,
                  n: cards.length,
                })
              : ''}
          </small>
        </div>
      </header>

      {/* 学科筛选 + 处理状态筛选 */}
      <div className="sticky top-[52px] z-10 border-b bg-white px-4 py-2">
        <div className="mx-auto flex max-w-2xl gap-2 overflow-x-auto">
          {subjects.map((s) => (
            <button
              key={s}
              onClick={() => setSubject(s)}
              className={`min-h-[40px] shrink-0 rounded-full px-4 text-sm font-medium ${
                subject === s
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {s === '全部' ? m['cuotiben.subject_all']() : s}
            </button>
          ))}
        </div>
        <div className="mx-auto mt-2 flex max-w-2xl gap-2">
          {(
            [
              ['all', m['cuotiben.subject_all'](), cards.length],
              ['pending', m['cuotiben.filter_pending'](), pendingCount],
              ['done', m['cuotiben.filter_done'](), masteredCount],
            ] as [StatusFilter, string, number][]
          ).map(([key, label, count]) => (
            <button
              key={key}
              onClick={() => setStatus(key)}
              className={`min-h-[40px] flex-1 rounded-full px-4 text-sm font-medium ${
                status === key
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {label} {count}
            </button>
          ))}
        </div>
      </div>

      <main className="mx-auto max-w-2xl p-3">
        {cardsQ.isLoading ? (
          <div className="py-20 text-center text-slate-500">
            {m['cuotiben.loading']()}
          </div>
        ) : (
          <TimelineTab
            cards={filtered}
            allEmpty={cards.length === 0}
            toggleMastered={(c) => toggleMut.mutate(c)}
            deleteCard={(id) => deleteMut.mutate(id)}
            invalidate={invalidate}
          />
        )}
      </main>
    </div>
  );
}
