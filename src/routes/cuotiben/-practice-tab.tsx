import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { apiGet, apiPost } from '@/lib/api-client';
import { m } from '@/paraglide/messages.js';

interface Practice {
  id: string;
  cardId: string;
  subject: string;
  tag: string;
  question: string;
  answer: string;
  principle: string;
  mastered: boolean;
  attempts: number;
  correctCount: number;
  createdAt: number;
}

export function PracticeTab({ subject }: { subject?: string }) {
  const queryClient = useQueryClient();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [results, setResults] = useState<
    Record<string, { correct: boolean; confidence: number; mock: boolean }>
  >({});
  const [showAnswer, setShowAnswer] = useState<Record<string, boolean>>({});

  const { data: practices = [], isLoading } = useQuery({
    queryKey: ['practice-list', subject],
    queryFn: () =>
      apiGet<Practice[]>(
        `/api/cuotiben?action=practice${subject ? `&subject=${subject}` : ''}`
      ),
  });

  const answerMut = useMutation({
    mutationFn: (vars: { practiceId: string; studentAnswer: string }) =>
      apiPost<{
        correct: boolean;
        confidence: number;
        mock: boolean;
        mastered: boolean;
      }>('/api/cuotiben', {
        action: 'practice',
        op: 'answer',
        practiceId: vars.practiceId,
        studentAnswer: vars.studentAnswer,
      }),
    onSuccess: (data, vars) => {
      setResults((r) => ({ ...r, [vars.practiceId]: data }));
      queryClient.invalidateQueries({ queryKey: ['practice-list'] });
      if (data.correct) {
        toast.success(data.mastered ? '已掌握！' : '答对了！');
      } else {
        toast.error('再想想');
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (practiceId: string) =>
      apiPost('/api/cuotiben', {
        action: 'practice',
        op: 'delete',
        practiceId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['practice-list'] });
      toast.success('已删除');
    },
  });

  if (isLoading) {
    return <div className="py-10 text-center text-slate-500">加载中...</div>;
  }

  const unmastered = practices.filter((p) => !p.mastered);
  const mastered = practices.filter((p) => p.mastered);

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
        AI 根据你的错题生成的练习题。连续答对 2
        次算掌握（独立于错题卡的掌握状态）。 共 {practices.length} 题，已掌握{' '}
        {mastered.length} 题。
      </div>

      {practices.length === 0 && (
        <div className="py-10 text-center text-slate-500">
          还没有练习题。去错题卡片点"📝 类似题"生成，或在下方批量生成。
        </div>
      )}

      {unmastered.map((p) => (
        <div key={p.id} className="rounded-lg border bg-white p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-700">
              {p.tag || '练习题'}
            </span>
            <span className="text-xs text-slate-400">
              已答 {p.attempts} 次，答对 {p.correctCount} 次
            </span>
          </div>
          <div className="mb-3 font-medium whitespace-pre-wrap">
            {p.question}
          </div>

          {!results[p.id] ? (
            <div className="flex gap-2">
              <input
                value={answers[p.id] || ''}
                onChange={(e) =>
                  setAnswers({ ...answers, [p.id]: e.target.value })
                }
                placeholder="输入你的答案..."
                className="min-h-[44px] flex-1 rounded-lg border px-3"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && answers[p.id]?.trim()) {
                    answerMut.mutate({
                      practiceId: p.id,
                      studentAnswer: answers[p.id],
                    });
                  }
                }}
              />
              <button
                onClick={() =>
                  answers[p.id]?.trim() &&
                  answerMut.mutate({
                    practiceId: p.id,
                    studentAnswer: answers[p.id],
                  })
                }
                disabled={answerMut.isPending || !answers[p.id]?.trim()}
                className="min-h-[44px] rounded-lg bg-blue-600 px-4 text-white disabled:opacity-50"
              >
                提交
              </button>
            </div>
          ) : (
            <div
              className={`rounded-lg p-3 text-sm ${
                results[p.id].correct
                  ? 'bg-green-50 text-green-800'
                  : 'bg-red-50 text-red-800'
              }`}
            >
              {results[p.id].correct ? '✓ 答对了' : '✗ 答错了'}
              {results[p.id].mock && '（本地判分）'}
              <button
                onClick={() =>
                  setShowAnswer({ ...showAnswer, [p.id]: !showAnswer[p.id] })
                }
                className="ml-2 text-blue-600 underline"
              >
                {showAnswer[p.id] ? '隐藏答案' : '看答案'}
              </button>
              {showAnswer[p.id] && (
                <div className="mt-2 whitespace-pre-wrap">
                  <div>
                    <b>答案：</b>
                    {p.answer}
                  </div>
                  {p.principle && (
                    <div className="mt-1">
                      <b>原理：</b>
                      {p.principle}
                    </div>
                  )}
                </div>
              )}
              {!results[p.id].correct && (
                <button
                  onClick={() => {
                    setResults((r) => {
                      const n = { ...r };
                      delete n[p.id];
                      return n;
                    });
                    setAnswers({ ...answers, [p.id]: '' });
                  }}
                  className="ml-2 text-blue-600 underline"
                >
                  再试一次
                </button>
              )}
            </div>
          )}

          <button
            onClick={() => {
              if (window.confirm('删除这道练习题？')) deleteMut.mutate(p.id);
            }}
            className="mt-2 text-xs text-slate-400 hover:text-red-500"
          >
            删除
          </button>
        </div>
      ))}

      {mastered.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 font-semibold text-green-700">
            已掌握（{mastered.length}）
          </h3>
          <div className="space-y-2">
            {mastered.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm"
              >
                <div className="whitespace-pre-wrap">{p.question}</div>
                <div className="mt-1 text-xs text-green-600">
                  ✓ 已掌握（答对 {p.correctCount}/{p.attempts}）
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
