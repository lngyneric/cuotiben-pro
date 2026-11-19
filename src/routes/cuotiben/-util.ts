/** 只渲染我们自己的 SVG 图，防止富文本 XSS */
export function safeDiagram(d: string | null): string | null {
  if (!d || !d.trim().startsWith('<svg')) return null;
  // 简易消毒：去掉事件处理器属性与 script（innerHTML 插入不执行 parser script，
  // 但 onload/onbegin 等仍可能触发）
  return d
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

/** 取文本第一个非空行（去首尾空白）。记事时间线每条只显示一句简述。 */
export function firstLine(text: string): string {
  const line = (text || '').split('\n').find((l) => l.trim() !== '');
  return (line ?? '').trim();
}

/** ISO 时间转 YYYY-MM-DD（本地时区）；解析失败时原样截前 10 位。 */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return (iso || '').slice(0, 10);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

// ─── CSV 批量导入 ──────────────────────────────────────────────────────────

/** CSV 导入用卡片（与后端 import 接口接受的字段一致；subject 一律空串）。 */
export type CsvImportCard = {
  question: string;
  answer: string;
  myAnswer: string;
  principle: string;
  note: string;
  tag: string;
  src: string;
  mastered: boolean;
  subject: string;
  kind: string;
};

/** 表头名（去空白＋小写）→ 卡片字段；subject 列有则忽略，未知列也忽略。 */
const CSV_HEADER_MAP: Record<string, keyof CsvImportCard | 'ignore'> = {
  question: 'question',
  内容: 'question',
  answer: 'answer',
  答案: 'answer',
  myanswer: 'myAnswer',
  我的答案: 'myAnswer',
  principle: 'principle',
  原理: 'principle',
  '原理/公式': 'principle',
  note: 'note',
  笔记: 'note',
  tag: 'tag',
  标签: 'tag',
  src: 'src',
  来源: 'src',
  mastered: 'mastered',
  已完成: 'mastered',
  subject: 'ignore',
  学科: 'ignore',
};

/** 已完成列取值：true / 1 / 是 → true，其余（false / 0 / 否 / 空 / 其他）→ false。 */
function parseMastered(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1' || v === '是';
}

/**
 * 按 CSV 常用子集解析文本：双引号字段、字段内逗号/换行、"" 转义双引号；
 * BOM、CRLF 与行尾 lone CR 均处理；空行跳过。
 */
function parseCsvRows(text: string): string[][] {
  const s = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
    } else if (ch === '"') {
      if (field === '') {
        inQuotes = true;
        i += 1;
      } else {
        field += ch;
        i += 1;
      }
    } else if (ch === ',') {
      pushField();
      i += 1;
    } else if (ch === '\n') {
      pushRow();
      i += 1;
    } else if (ch === '\r') {
      if (s[i + 1] === '\n') {
        i += 1; // CRLF 的 \r 跳过，由后面的 \n 收尾
      } else {
        pushRow(); // 行尾 lone CR 也算换行
        i += 1;
      }
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

/**
 * 把 CSV 文本解析成导入用卡片数组。首行是表头（中英均可）；
 * 内容与答案必填，缺失的行跳过并计入 skipped；subject 列忽略。
 * 表头里既无内容列又无答案列、或全文为空时抛错。
 */
export function parseCsvToCards(text: string): {
  cards: CsvImportCard[];
  skipped: number;
} {
  const rows = parseCsvRows(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length === 0) throw new Error('empty file');
  const colMap = rows[0].map(
    (h) => CSV_HEADER_MAP[h.trim().toLowerCase()] ?? null
  );
  if (!colMap.includes('question') || !colMap.includes('answer')) {
    throw new Error('missing question/answer column');
  }
  const cards: CsvImportCard[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const get = (field: keyof CsvImportCard): string => {
      const idx = colMap.indexOf(field);
      return idx === -1 ? '' : (row[idx] ?? '').trim();
    };
    const question = get('question');
    const answer = get('answer');
    if (!question || !answer) {
      skipped += 1;
      continue;
    }
    cards.push({
      question,
      answer,
      myAnswer: get('myAnswer'),
      principle: get('principle'),
      note: get('note'),
      tag: get('tag'),
      src: get('src'),
      mastered: parseMastered(get('mastered')),
      subject: '',
      kind: 'mistake',
    });
  }
  return { cards, skipped };
}
