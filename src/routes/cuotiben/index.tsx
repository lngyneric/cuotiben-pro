import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

export const Route = createFileRoute('/cuotiben/')({
  component: CuotibenPage,
});

type Card = {
  id: string;
  src: string;
  subject: string;
  tag: string;
  question: string;
  myAnswer: string;
  answer: string;
  principle: string;
  note: string;
  diagram?: string;
  mastered: boolean;
};

function CuotibenPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [showAnswer, setShowAnswer] = useState<Record<string, boolean>>({});
  const [studyMode, setStudyMode] = useState(false);
  const [studyIdx, setStudyIdx] = useState(0);
  const [dueCards, setDueCards] = useState<Card[]>([]);

  const load = async () => {
    setLoading(true);
    const r = await fetch('/api/cuotiben');
    const j = await r.json();
    if (j.data) setCards(j.data);
    setLoading(false);
  };

  const loadDue = async () => {
    const r = await fetch('/api/cuotiben?action=due');
    const j = await r.json();
    if (j.data) {
      setDueCards(j.data);
      setStudyIdx(0);
      setStudyMode(true);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const toggleMastered = async (c: Card) => {
    await fetch('/api/cuotiben', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: c.id, card: { mastered: !c.mastered } }),
    });
    load();
  };

  const logResult = async (cardId: string, ok: boolean) => {
    await fetch('/api/cuotiben', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'log', cardId, kind: 'review', ok }),
    });
    if (studyIdx + 1 < dueCards.length) {
      setStudyIdx(studyIdx + 1);
    } else {
      setStudyMode(false);
      loadDue();
    }
    setShowAnswer({});
  };

  const filtered = cards.filter(
    (c) =>
      !filter ||
      c.subject.includes(filter) ||
      c.tag.includes(filter) ||
      c.question.includes(filter)
  );

  if (studyMode && dueCards.length > 0) {
    const c = dueCards[studyIdx];
    const revealed = showAnswer[c.id];
    return (
      <div className="mx-auto max-w-2xl p-4">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-bold">
            学习模式 {studyIdx + 1}/{dueCards.length}
          </h1>
          <button
            onClick={() => setStudyMode(false)}
            className="rounded bg-gray-200 px-3 py-1 text-sm"
          >
            退出
          </button>
        </div>
        <div className="rounded-lg border p-6 shadow">
          <div className="mb-2 text-sm text-gray-500">
            {c.subject} · {c.tag}
          </div>
          <div className="mb-4 text-lg">{c.question}</div>
          {c.diagram && (
            <div
              className="mb-4"
              dangerouslySetInnerHTML={{ __html: c.diagram }}
            />
          )}
          {!revealed ? (
            <button
              onClick={() => setShowAnswer({ [c.id]: true })}
              className="w-full rounded bg-blue-500 py-2 text-white"
            >
              显示答案
            </button>
          ) : (
            <div>
              <div className="mb-2 rounded bg-green-50 p-3">
                <div className="font-semibold">答案</div>
                <div>{c.answer}</div>
              </div>
              <div className="mb-4 rounded bg-yellow-50 p-3">
                <div className="font-semibold">原理</div>
                <div>{c.principle}</div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => logResult(c.id, false)}
                  className="flex-1 rounded bg-red-500 py-2 text-white"
                >
                  没记住
                </button>
                <button
                  onClick={() => logResult(c.id, true)}
                  className="flex-1 rounded bg-green-500 py-2 text-white"
                >
                  记住了
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">错题本</h1>
        <button
          onClick={loadDue}
          className="rounded bg-blue-500 px-4 py-2 text-white"
        >
          开始学习
        </button>
      </div>

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="搜索题目、标签、学科..."
        className="mb-4 w-full rounded border p-2"
      />

      {loading ? (
        <div>加载中...</div>
      ) : (
        <div className="space-y-3">
          {filtered.map((c) => (
            <div key={c.id} className="rounded-lg border p-4 shadow-sm">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm text-gray-500">
                  {c.src} · {c.subject} · {c.tag}
                </span>
                <button
                  onClick={() => toggleMastered(c)}
                  className={`rounded px-2 py-1 text-xs ${
                    c.mastered
                      ? 'bg-green-100 text-green-800'
                      : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {c.mastered ? '已掌握' : '未掌握'}
                </button>
              </div>
              <div className="mb-2 font-medium">{c.question}</div>
              {c.diagram && (
                <div
                  className="mb-2"
                  dangerouslySetInnerHTML={{ __html: c.diagram }}
                />
              )}
              {!showAnswer[c.id] ? (
                <button
                  onClick={() => setShowAnswer({ ...showAnswer, [c.id]: true })}
                  className="text-sm text-blue-500"
                >
                  显示答案
                </button>
              ) : (
                <div className="mt-2 space-y-2 text-sm">
                  <div>
                    <span className="font-semibold">我的答案：</span>
                    {c.myAnswer}
                  </div>
                  <div>
                    <span className="font-semibold">正确答案：</span>
                    {c.answer}
                  </div>
                  <div>
                    <span className="font-semibold">原理：</span>
                    {c.principle}
                  </div>
                  {c.note && (
                    <div>
                      <span className="font-semibold">备注：</span>
                      {c.note}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="text-center text-gray-500">暂无错题</div>
          )}
        </div>
      )}
    </div>
  );
}
