// 记事本时间线：按 createdAt 倒序，每条只显示一句简述
// （内容第一行，内容空则取笔记第一行）＋日期＋来源/科目/标签 chips＋
// 已完成/待处理徽标。点开看全文（内容、我的答案、答案、原理、笔记、图），
// 每条带锚点 id（#note-<id>）可直达。只改页面 UI，不动 API、不动数据库。
// 注意：路由文件按约定用 `-` 前缀拆分（colocated non-route files）
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';

import { apiPost } from '@/lib/api-client';
import { m } from '@/paraglide/messages.js';

import type { Card } from './-types';
import { firstLine, formatDate, safeDiagram } from './-util';

export function TimelineTab({
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
          onClick={() => setShowImport(!showImport)}
          className="min-h-[44px] shrink-0 rounded-lg bg-slate-100 px-4 text-sm text-slate-600"
        >
          {m['cuotiben.btn_import_json']()}
        </button>
      </div>

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

      {allEmpty && filtered.length === 0 && (
        <div className="py-10 text-center text-slate-500">
          {m['cuotiben.empty_cards']()}
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((c) => {
          const open = !!expanded[c.id];
          const diagram = safeDiagram(c.diagram);
          const summary = firstLine(c.question) || firstLine(c.note);
          return (
            <div
              key={c.id}
              id={`note-${c.id}`}
              className="rounded-xl bg-white p-4 shadow-sm"
            >
              <div className="mb-1 flex flex-wrap items-center gap-1">
                <span className="text-xs text-slate-400">
                  {formatDate(c.createdAt)}
                </span>
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
              <button
                type="button"
                onClick={() => setExpanded({ ...expanded, [c.id]: !open })}
                className="my-2 block w-full truncate text-left font-medium"
                title={summary}
              >
                {summary}
              </button>
              {diagram && (
                <div
                  className="my-2 text-center"
                  dangerouslySetInnerHTML={{ __html: diagram }}
                />
              )}
              {open && (
                <div className="mt-2 space-y-2 border-t pt-2 text-sm">
                  <div className="whitespace-pre-wrap">{c.question}</div>
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
              </div>
            </div>
          );
        })}
        {!allEmpty && filtered.length === 0 && (
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
              'English Writing',
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
