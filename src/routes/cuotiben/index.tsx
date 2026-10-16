import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { toast } from 'sonner';

import { apiDelete, apiGet, apiPost, apiPut } from '@/lib/api-client';
import { m } from '@/paraglide/messages.js';

import { CardsTab } from './-cards-tab';
import { FlashTab } from './-flash-tab';
import { QaTab } from './-qa-tab';
import { StudyTab } from './-study-tab';
import { CARDS_KEY, DUE_KEY, STATS_KEY, type Card } from './-types';

export const Route = createFileRoute('/cuotiben/')({
  component: CuotibenPage,
});

const SUBJECTS = ['全部', 'Math', '数学', 'Science'];

// ─── 数据 hooks（TanStack Query + api-client，不用裸 fetch） ──────────────────

function useCards() {
  return useQuery({
    queryKey: CARDS_KEY,
    queryFn: () => apiGet<Card[]>('/api/cuotiben'),
  });
}

function useInvalidateCuotiben() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: CARDS_KEY }),
      qc.invalidateQueries({ queryKey: DUE_KEY }),
      qc.invalidateQueries({ queryKey: STATS_KEY }),
    ]);
}

function useLog() {
  const invalidate = useInvalidateCuotiben();
  return useMutation({
    mutationFn: (v: {
      cardId: string;
      kind: string;
      ok: boolean;
      skip?: boolean;
    }) => apiPost('/api/cuotiben', { action: 'log', ...v }),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });
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

type Tab = 'cards' | 'flash' | 'study' | 'qa';

function CuotibenPage() {
  const [tab, setTab] = useState<Tab>('cards');
  const [subject, setSubject] = useState('全部');
  const cardsQ = useCards();
  const invalidate = useInvalidateCuotiben();
  const logMut = useLog();
  const toggleMut = useToggleMastered();
  const deleteMut = useDeleteCard();

  const cards = cardsQ.data ?? [];
  const subjects = useMemo(() => {
    const extra = [
      ...new Set(cards.map((c) => c.subject).filter(Boolean)),
    ].filter((s) => !SUBJECTS.includes(s));
    return [...SUBJECTS, ...extra];
  }, [cards]);
  const filtered = useMemo(
    () =>
      subject === '全部' ? cards : cards.filter((c) => c.subject === subject),
    [cards, subject]
  );
  const masteredCount = cards.filter((c) => c.mastered).length;

  const log = (v: {
    cardId: string;
    kind: string;
    ok: boolean;
    skip?: boolean;
  }) => logMut.mutate(v);

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
      <style>{`
        .fc-wrap{perspective:1200px}
        .fc{position:relative;min-height:320px;cursor:pointer}
        .fc-in{position:absolute;inset:0;transform-style:preserve-3d;transition:transform .45s}
        .fc.flip .fc-in{transform:rotateY(180deg)}
        .fc-face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;background:#fff;border-radius:18px;box-shadow:0 4px 16px rgba(0,0,0,.1);padding:22px;display:flex;flex-direction:column;justify-content:center;overflow:auto}
        .fc-back{transform:rotateY(180deg)}
      `}</style>

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

      {/* 学科筛选：4 个 tab 共用 */}
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
      </div>

      <main className="mx-auto max-w-2xl p-3">
        {cardsQ.isLoading ? (
          <div className="py-20 text-center text-slate-500">
            {m['cuotiben.loading']()}
          </div>
        ) : (
          <>
            {tab === 'cards' && (
              <CardsTab
                cards={filtered}
                allEmpty={cards.length === 0}
                toggleMastered={(c) => toggleMut.mutate(c)}
                deleteCard={(id) => deleteMut.mutate(id)}
                invalidate={invalidate}
              />
            )}
            {tab === 'flash' && (
              <FlashTab
                cards={filtered}
                toggleMastered={(c) => toggleMut.mutate(c)}
                log={log}
              />
            )}
            {tab === 'study' && <StudyTab subject={subject} log={log} />}
            {tab === 'qa' && <QaTab cards={filtered} log={log} />}
          </>
        )}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-10 border-t bg-white">
        <div className="mx-auto flex max-w-2xl">
          {(
            [
              ['cards', '📝', m['cuotiben.tab_cards']()],
              ['flash', '🃏', m['cuotiben.tab_flash']()],
              ['study', '📊', m['cuotiben.tab_study']()],
              ['qa', '💬', m['cuotiben.tab_qa']()],
            ] as [Tab, string, string][]
          ).map(([key, icon, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`min-h-[60px] flex-1 py-2 text-xs ${
                tab === key ? 'font-bold text-blue-600' : 'text-slate-500'
              }`}
            >
              <span className="block text-xl">{icon}</span>
              {label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
