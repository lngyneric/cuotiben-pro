// 错题 tab：列表 / 搜索 / 展开详情 / 已掌握切换 / 新增 / JSON 导入
// 注意：路由文件按约定用 `-` 前缀拆分（colocated non-route files）
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import { apiPost } from '@/lib/api-client';
import { m } from '@/paraglide/messages.js';

import type { Card } from './-types';
import { safeDiagram } from './-util';

// 导出单文件闪卡 HTML（离线可看）
function exportFlashcards(cards: Card[]) {
  const esc = (s: string) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const cardsHtml = cards
    .map(
      (c, i) => `
    <div class="card" onclick="this.classList.toggle('flip')">
      <div class="inner">
        <div class="front">
          <div class="num">#${i + 1} ${esc(c.tag || '')}</div>
          <div class="q">${esc(c.question)}</div>
          <div class="tap">点击翻面</div>
        </div>
        <div class="back">
          <div class="a"><b>答案：</b>${esc(c.answer)}</div>
          ${c.principle ? `<div class="p"><b>原理：</b>${esc(c.principle)}</div>` : ''}
          ${c.note ? `<div class="n"><b>错因：</b>${esc(c.note)}</div>` : ''}
        </div>
      </div>
    </div>`
    )
    .join('\n');
  const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>错题闪卡</title><style>
body{font-family:system-ui;margin:0;padding:16px;background:#f5f5f5}
.card{perspective:1000px;margin:12px auto;max-width:600px;cursor:pointer}
.inner{position:relative;min-height:200px;transition:transform .6s;transform-style:preserve-3d}
.card.flip .inner{transform:rotateY(180deg)}
.front,.back{position:absolute;inset:0;backface-visibility:hidden;background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.back{transform:rotateY(180deg)}
.num{color:#888;font-size:12px;margin-bottom:8px}
.q{font-size:17px;line-height:1.6;white-space:pre-wrap}
.tap{color:#aaa;font-size:12px;margin-top:12px;text-align:center}
.a,.p,.n{margin:8px 0;line-height:1.6;white-space:pre-wrap}
h1{text-align:center}
</style></head><body><h1>错题闪卡（${cards.length} 张）</h1>${cardsHtml}</body></html>`;
  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '错题闪卡.html';
  a.click();
  URL.revokeObjectURL(a.href);
}

// 类似题按钮：调用 AI 生成同类练习题
function SimilarButton({ cardId }: { cardId: string }) {
  const [result, setResult] = useState<{
    question: string;
    answer: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState(false);

  const generate = async () => {
    if (result) {
      setShow(!show);
      return;
    }
    setLoading(true);
    try {
      const data = await apiPost<{ question: string; answer: string }>(
        '/api/cuotiben',
        { action: 'similar', cardId }
      );
      setResult(data);
      setShow(true);
    } catch (e: any) {
      toast.error(e.message || '生成失败');
    }
    setLoading(false);
  };

  return (
    <div className="w-full">
      <button
        onClick={generate}
        disabled={loading}
        className="min-h-[40px] rounded-lg bg-purple-50 px-3 text-sm text-purple-700 disabled:opacity-50"
      >
        {loading ? '生成中...' : '📝 类似题'}
      </button>
      {show && result && (
        <div className="mt-2 rounded-lg bg-purple-50 p-3 text-sm">
          <div className="font-semibold text-purple-900">类似练习题：</div>
          <div className="mt-1 whitespace-pre-wrap">{result.question}</div>
          <div className="mt-2 font-semibold text-purple-900">答案：</div>
          <div className="whitespace-pre-wrap">{result.answer}</div>
        </div>
      )}
    </div>
  );
}

export function CardsTab({
  cards,
  allEmpty,
  toggleMastered,
  deleteCard,
  invalidate,
}: {
  cards: Card[];
  allEmpty: boolean;
  toggleMastered: (c: Card) => void;
  deleteCard: (id: string) => void;
  invalidate: () => void;
}) {
  const [kw, setKw] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [importing, setImporting] = useState(false);

  const filtered = cards.filter(
    (c) =>
      !kw ||
      c.question.includes(kw) ||
      c.tag.includes(kw) ||
      c.subject.includes(kw) ||
      (c.src || '').includes(kw)
  );

  const seedMut = useMutation({
    mutationFn: () =>
      apiPost<{ count: number }>('/api/cuotiben', { action: 'seed' }),
    onSuccess: (d) => {
      toast.success(m['cuotiben.imported']({ count: d.count }));
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const doImport = async () => {
    setImporting(true);
    try {
      const parsed = JSON.parse(importJson);
      const d = await apiPost<{ count: number }>('/api/cuotiben', {
        action: 'import',
        cards: parsed,
      });
      toast.success(m['cuotiben.imported']({ count: d.count }));
      setShowImport(false);
      setImportJson('');
      invalidate();
    } catch (e: any) {
      toast.error(`${m['cuotiben.invalid_json']()}: ${e.message}`);
    }
    setImporting(false);
  };

  return (
    <div>
      <div className="mb-3 flex gap-2">
        <input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          placeholder={m['cuotiben.search_placeholder']()}
          className="min-h-[44px] flex-1 rounded-lg border px-3"
        />
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="min-h-[44px] shrink-0 rounded-lg bg-blue-600 px-4 text-white"
        >
          {m['cuotiben.btn_add']()}
        </button>
        <button
          onClick={() => exportFlashcards(cards)}
          className="min-h-[44px] shrink-0 rounded-lg bg-slate-600 px-4 text-white"
          title="导出单文件闪卡 HTML"
        >
          ⤓闪卡
        </button>
      </div>

      {allEmpty && (
        <div className="mb-3 flex gap-2">
          <button
            onClick={() => seedMut.mutate()}
            disabled={seedMut.isPending}
            className="min-h-[44px] flex-1 rounded-lg bg-green-600 px-4 text-white disabled:opacity-50"
          >
            {m['cuotiben.btn_import_seed']()}
          </button>
          <button
            onClick={() => setShowImport(!showImport)}
            className="min-h-[44px] flex-1 rounded-lg bg-purple-600 px-4 text-white"
          >
            {m['cuotiben.btn_import_json']()}
          </button>
        </div>
      )}

      {showImport && (
        <div className="mb-3 rounded-lg border bg-white p-4">
          <h3 className="mb-2 font-bold">{m['cuotiben.import_title']()}</h3>
          <input
            type="file"
            accept=".json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                const r = new FileReader();
                r.onload = () => setImportJson(r.result as string);
                r.readAsText(f);
              }
            }}
            className="mb-2 w-full"
          />
          <textarea
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            placeholder={m['cuotiben.import_placeholder']()}
            className="mb-2 h-32 w-full rounded-lg border p-2 font-mono text-sm"
          />
          <button
            disabled={importing || !importJson.trim()}
            onClick={doImport}
            className="min-h-[44px] rounded-lg bg-purple-600 px-4 text-white disabled:opacity-50"
          >
            {importing
              ? m['cuotiben.importing']()
              : m['cuotiben.btn_do_import']()}
          </button>
        </div>
      )}

      {showAdd && (
        <AddCardForm
          onDone={() => {
            setShowAdd(false);
            invalidate();
          }}
        />
      )}

      <div className="space-y-3">
        {filtered.map((c) => {
          const open = !!expanded[c.id];
          const diagram = safeDiagram(c.diagram);
          return (
            <div key={c.id} className="rounded-xl bg-white p-4 shadow-sm">
              <div className="mb-1 flex flex-wrap items-center gap-1">
                {c.src && (
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                    {c.src}
                  </span>
                )}
                <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                  {c.subject}
                </span>
                {c.tag && (
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                    {c.tag}
                  </span>
                )}
                <span
                  className={`ml-auto rounded-full px-2 py-0.5 text-xs ${
                    c.mastered
                      ? 'bg-green-100 text-green-700'
                      : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {c.mastered
                    ? m['cuotiben.badge_mastered']()
                    : m['cuotiben.badge_unmastered']()}
                </span>
              </div>
              <div className="my-2 font-medium whitespace-pre-wrap">
                {c.question}
              </div>
              {diagram && (
                <div
                  className="my-2 text-center"
                  dangerouslySetInnerHTML={{ __html: diagram }}
                />
              )}
              {open && (
                <div className="mt-2 space-y-2 border-t pt-2 text-sm">
                  {c.myAnswer && (
                    <div>
                      <span className="font-semibold text-slate-500">
                        {m['cuotiben.label_my_answer']()}：
                      </span>
                      <span className="whitespace-pre-wrap">{c.myAnswer}</span>
                    </div>
                  )}
                  <div className="rounded-r-lg border-l-4 border-blue-600 bg-slate-50 p-2">
                    <span className="font-semibold">
                      ✅ {m['cuotiben.label_answer']()}：
                    </span>
                    <span className="whitespace-pre-wrap">{c.answer}</span>
                  </div>
                  {c.principle && (
                    <div>
                      <span className="font-semibold text-slate-500">
                        📌 {m['cuotiben.label_principle']()}：
                      </span>
                      <span className="whitespace-pre-wrap">{c.principle}</span>
                    </div>
                  )}
                  {c.note && (
                    <div>
                      <span className="font-semibold text-slate-500">
                        ⚠️ {m['cuotiben.label_note']()}：
                      </span>
                      <span className="whitespace-pre-wrap">{c.note}</span>
                    </div>
                  )}
                </div>
              )}
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => setExpanded({ ...expanded, [c.id]: !open })}
                  className="min-h-[40px] rounded-lg bg-slate-100 px-3 text-sm text-blue-700"
                >
                  {m['cuotiben.btn_detail']()}
                </button>
                <button
                  onClick={() => toggleMastered(c)}
                  className={`min-h-[40px] rounded-lg px-3 text-sm ${
                    c.mastered
                      ? 'bg-slate-100 text-slate-600'
                      : 'bg-green-100 text-green-700'
                  }`}
                >
                  {c.mastered
                    ? m['cuotiben.btn_unmaster']()
                    : m['cuotiben.btn_mastered']()}
                </button>
                <button
                  onClick={() => {
                    if (window.confirm(m['cuotiben.confirm_delete']()))
                      deleteCard(c.id);
                  }}
                  className="min-h-[40px] rounded-lg bg-red-50 px-3 text-sm text-red-600"
                >
                  {m['cuotiben.btn_delete']()}
                </button>
                <SimilarButton cardId={c.id} />
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="py-10 text-center text-slate-500">
            {m['cuotiben.empty_cards']()}
          </div>
        )}
      </div>
    </div>
  );
}

function AddCardForm({ onDone }: { onDone: () => void }) {
  const [subject, setSubject] = useState('上海数学');
  const [src, setSrc] = useState('中文数学');
  const [tag, setTag] = useState('');
  const [question, setQuestion] = useState('');
  const [myAnswer, setMyAnswer] = useState('');
  const [answer, setAnswer] = useState('');
  const [principle, setPrinciple] = useState('');
  const [note, setNote] = useState('');

  const saveMut = useMutation({
    mutationFn: () =>
      apiPost('/api/cuotiben', {
        action: 'create',
        card: {
          subject,
          src,
          tag,
          question,
          myAnswer,
          answer,
          principle,
          note,
          kind: 'mistake',
        },
      }),
    onSuccess: () => {
      toast.success(m['cuotiben.saved']());
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const inputCls = 'min-h-[44px] w-full rounded-lg border px-3 py-2';
  const labelCls = 'mb-1 block text-sm text-slate-500';

  return (
    <div className="mb-3 rounded-xl bg-white p-4 shadow-sm">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>{m['cuotiben.form_subject']()}</label>
          <select
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className={inputCls}
          >
            {[
              'IGMath',
              '上海数学',
              'Science',
              '英语',
              '物理',
              '化学',
              '其他',
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>{m['cuotiben.form_src']()}</label>
          <select
            value={src}
            onChange={(e) => setSrc(e.target.value)}
            className={inputCls}
          >
            {['中文数学', 'igmath', 'igscience'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-2">
        <label className={labelCls}>{m['cuotiben.form_tag']()}</label>
        <input
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          className={inputCls}
        />
      </div>
      <div className="mt-2">
        <label className={labelCls}>{m['cuotiben.form_question']()}</label>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          className={`${inputCls} min-h-[90px]`}
        />
      </div>
      <div className="mt-2">
        <label className={labelCls}>{m['cuotiben.form_my_answer']()}</label>
        <textarea
          value={myAnswer}
          onChange={(e) => setMyAnswer(e.target.value)}
          className={`${inputCls} min-h-[70px]`}
        />
      </div>
      <div className="mt-2">
        <label className={labelCls}>{m['cuotiben.form_answer']()}</label>
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          className={`${inputCls} min-h-[70px]`}
        />
      </div>
      <div className="mt-2">
        <label className={labelCls}>{m['cuotiben.form_principle']()}</label>
        <textarea
          value={principle}
          onChange={(e) => setPrinciple(e.target.value)}
          className={`${inputCls} min-h-[70px]`}
        />
      </div>
      <div className="mt-2">
        <label className={labelCls}>{m['cuotiben.form_note']()}</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={`${inputCls} min-h-[70px]`}
        />
      </div>
      <button
        disabled={saveMut.isPending}
        onClick={() => {
          if (!question.trim() || !answer.trim()) {
            toast.error(m['cuotiben.need_qa']());
            return;
          }
          saveMut.mutate();
        }}
        className="mt-3 min-h-[44px] w-full rounded-lg bg-blue-600 text-white disabled:opacity-50"
      >
        {m['cuotiben.btn_save']()}
      </button>
    </div>
  );
}
