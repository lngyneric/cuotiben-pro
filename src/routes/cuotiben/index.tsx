// 记事本：时间线首页。只改页面 UI，不动 API、不动数据库。
// 下线的四个 tab（闪卡 / 学习 SRS / AI 问答 / 练一练）与今日统计已移除，
// 答题记录（qa_log / srs / practice）不再展示，但库里的行全部保留。
// 未掌握的条目就是待处理的提醒事项，不用答题记录算。
// 主题：跟站内其它页一致，走 ShipAny 统一主题（Header/Footer＋主题 token，
// 不再用写死的 slate/blue 配色与自定义蓝底 header）。
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { toast } from 'sonner';

import { apiDelete, apiGet, apiPut } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';
import { Footer } from '@/blocks/footer';
import { Header } from '@/blocks/header';

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

// ─── Wiki 操作时间线（只读聚合，见 src/modules/cuotiben/timeline.ts） ──────

type TimelineCategory =
  | 'assistant'
  | 'card'
  | 'admin'
  | 'html'
  | 'mentor'
  | 'system';

type TimelineEvent = {
  id: string;
  at: number;
  category: TimelineCategory;
  title: string;
  detail?: string;
  href?: string;
};

type TimelineTodos = {
  pendingConfirm: number;
  overdue: number;
  unresolvedIdentity: number;
  noCourseActivity: number;
};

type WikiTimeline = {
  events: TimelineEvent[];
  todos: TimelineTodos;
};

const TIMELINE_KEY = ['cuotiben-timeline'];
const TODOS_VISIBLE_KEY = 'cuotiben-todos-visible';

const OPS_CATEGORIES: (TimelineCategory | 'all')[] = [
  'all',
  'assistant',
  'admin',
  'mentor',
  'system',
  'html',
  'card',
];

function opsCategoryLabel(cat: TimelineCategory | 'all'): string {
  switch (cat) {
    case 'all':
      return m['cuotiben.subject_all']();
    case 'assistant':
      return m['cuotiben.ops_cat_assistant']();
    case 'admin':
      return m['cuotiben.ops_cat_admin']();
    case 'mentor':
      return m['cuotiben.ops_cat_mentor']();
    case 'system':
      return m['cuotiben.ops_cat_system']();
    case 'html':
      return m['cuotiben.ops_cat_html']();
    case 'card':
      return m['cuotiben.ops_cat_card']();
  }
}

/** 毫秒时间戳 → 本地日期时间（浏览器时区）；解析失败返回空。 */
function formatTimelineAt(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function useTimeline() {
  return useQuery({
    queryKey: TIMELINE_KEY,
    queryFn: () => apiGet<WikiTimeline>('/api/cuotiben/timeline'),
  });
}

function OpsSection() {
  const timelineQ = useTimeline();
  const [cat, setCat] = useState<TimelineCategory | 'all'>('all');
  // 待办面板显示开关：默认显示，记 localStorage；挂载后读，避免 SSR 水合不一致
  //（与 blog 分屏的 viewMode 同一做法，刷新瞬间可能闪一下）。
  const [todosVisible, setTodosVisible] = useState(true);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(TODOS_VISIBLE_KEY) === '0')
        setTodosVisible(false);
    } catch {
      // localStorage 不可用时保持默认显示
    }
  }, []);
  const toggleTodosVisible = () => {
    setTodosVisible((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(TODOS_VISIBLE_KEY, next ? '1' : '0');
      } catch {
        // 写入失败不阻塞
      }
      return next;
    });
  };

  const events = timelineQ.data?.events ?? [];
  const todos = timelineQ.data?.todos;
  const hasTodos =
    !!todos &&
    (todos.pendingConfirm > 0 ||
      todos.overdue > 0 ||
      todos.unresolvedIdentity > 0 ||
      todos.noCourseActivity > 0);
  const filtered =
    cat === 'all' ? events : events.filter((e) => e.category === cat);

  return (
    <section className="mt-10">
      <h2 className="text-xl font-bold">{m['cuotiben.ops_title']()}</h2>

      {/* 待办面板：常驻提醒，标题行右侧可隐藏；隐藏后只留一行加显示按钮 */}
      {hasTodos && todos && todosVisible && (
        <div className="border-border bg-card mt-4 rounded-2xl border p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">{m['cuotiben.todo_title']()}</h3>
            <button
              onClick={toggleTodosVisible}
              className="text-muted-foreground min-h-[32px] px-2 text-sm underline"
            >
              {m['cuotiben.todo_hide']()}
            </button>
          </div>
          <ul className="mt-2 space-y-1 text-sm">
            {todos.pendingConfirm > 0 && (
              <li>
                {m['cuotiben.todo_pending_confirm']({
                  n: todos.pendingConfirm,
                })}
              </li>
            )}
            {todos.overdue > 0 && (
              <li>{m['cuotiben.todo_overdue']({ n: todos.overdue })}</li>
            )}
            {todos.unresolvedIdentity > 0 && (
              <li>
                {m['cuotiben.todo_unresolved']({
                  n: todos.unresolvedIdentity,
                })}
              </li>
            )}
            {todos.noCourseActivity > 0 && (
              <li>
                {m['cuotiben.todo_no_course']({
                  n: todos.noCourseActivity,
                })}
              </li>
            )}
          </ul>
        </div>
      )}
      {hasTodos && !todosVisible && (
        <div className="border-border bg-card mt-4 flex items-center justify-between rounded-2xl border p-4">
          <span className="text-muted-foreground text-sm">
            {m['cuotiben.todo_hidden']()}
          </span>
          <button
            onClick={toggleTodosVisible}
            className="bg-primary text-primary-foreground min-h-[32px] rounded-full px-4 text-sm font-medium"
          >
            {m['cuotiben.todo_show']()}
          </button>
        </div>
      )}

      {/* 分类筛选 */}
      <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
        {OPS_CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => setCat(c)}
            className={cn(
              'min-h-[40px] shrink-0 rounded-full px-4 text-sm font-medium',
              cat === c
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground'
            )}
          >
            {opsCategoryLabel(c)}
          </button>
        ))}
      </div>

      {/* 事件列表 */}
      {timelineQ.isLoading ? (
        <div className="text-muted-foreground py-8 text-center">
          {m['cuotiben.loading']()}
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center">
          {m['cuotiben.ops_empty']()}
        </p>
      ) : (
        <ul className="divide-border mt-2 divide-y">
          {filtered.map((ev) => (
            <li key={ev.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="bg-secondary text-secondary-foreground shrink-0 rounded-full px-2 py-0.5 text-xs">
                  {opsCategoryLabel(ev.category)}
                </span>
                {ev.href ? (
                  <a href={ev.href} className="font-medium underline">
                    {ev.title}
                  </a>
                ) : (
                  <span className="font-medium">{ev.title}</span>
                )}
              </div>
              {ev.detail && (
                <p className="text-muted-foreground mt-1 text-sm">
                  {ev.detail}
                </p>
              )}
              <p className="text-muted-foreground mt-1 text-xs">
                {formatTimelineAt(ev.at)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
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
      <div className="bg-background text-foreground flex min-h-screen flex-col">
        <Header />
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-16 text-center">
          <p className="mb-4">{m['cuotiben.need_login']()}</p>
          <a
            href="/sign-in"
            className="bg-primary text-primary-foreground inline-block min-h-[48px] rounded-lg px-6 py-3"
          >
            {m['cuotiben.go_login']()}
          </a>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        <h1 className="text-2xl font-bold">{m['cuotiben.title']()}</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          {m['cuotiben.description']()}
          {cards.length
            ? ` ${m['cuotiben.mastered_count']({
                m: masteredCount,
                n: cards.length,
              })}`
            : ''}
        </p>

        {/* 学科筛选 + 处理状态筛选 */}
        <div className="mt-6">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {subjects.map((s) => (
              <button
                key={s}
                onClick={() => setSubject(s)}
                className={cn(
                  'min-h-[40px] shrink-0 rounded-full px-4 text-sm font-medium',
                  subject === s
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {s === '全部' ? m['cuotiben.subject_all']() : s}
              </button>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
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
                className={cn(
                  'min-h-[40px] flex-1 rounded-full px-4 text-sm font-medium',
                  status === key
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {label} {count}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6">
          {cardsQ.isLoading ? (
            <div className="text-muted-foreground py-20 text-center">
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
        </div>

        <OpsSection />
      </main>
      <Footer />
    </div>
  );
}
