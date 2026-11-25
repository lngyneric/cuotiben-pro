// 图表与 Dashboard —— 阶段 3 能力四（实施清单能力四）。
//
// 纯函数层 + zip 手术：只对 PPTX 字节做手术，不碰数据库、不调 Presenton。
// 不接受“帮我编一组数”：没有数据就明确拒绝，不生成示例数字。
//
// 技术路线（已核查，见本文件头部结论）：
// - Presenton 自托管 v1 REST API（/generate/async 与 /create）只接受
//   提示词/说明文本（content、instructions、tone、verbosity、template
//   等），没有任何“结构化图表数据”参数；wiki 无法把 categories/series、
//   图表类型或标签开关确定性地传给它。让 LLM 从说明文本里“顺便画一张
//   原生图”是不可验证的——成图与否、数据对不对、标签显隐都无法保证，
//   故不走 Presenton 画图。
// - 按阶段 0/2 的 zip 级手术路子自己实现：往 pptx 里加 chart 部件
//   （ppt/charts/chartN.xml，c:chart）＋内嵌 xlsx 工作簿
//   （ppt/embeddings/Microsoft_Excel_Worksheet*.xlsx，含真实数据），
//   slide 里加 graphicFrame 引用。PowerPoint 双击可改数、改类型；
//   不引新重型依赖（只有 node:zlib + 字符串模板）。
// - 标签显隐（value_labels）只改图表 XML 的标签层（c:dLbls / 逐点
//   c:dLbl），数据（工作簿 + numRef）与坐标轴（catAx/valAx）不动。
//   total_only 的合计数字以逐点标签文本写在标签层，不改底层数据。
// - 配色只用主题色板（layouts.ts 的 PPT_THEME_COLORS）：系列按
//   THEME_SERIES_COLORS 顺序取色，饼/环形的每片按同一顺序取色，
//   与图例一一对应，不自创配色。

import { crc32, deflateRawSync } from 'node:zlib';

import {
  addZipEntries,
  buildElementIndex,
  readZipEntries,
  readZipEntry,
  replaceZipEntry,
} from './element-index';
import { PresentonError } from './errors';
import { PPT_THEME_COLORS } from './layouts';
import { scanShapeSpans, type RectIn } from './page-edit';

export type ChartType = 'bar' | 'line' | 'pie' | 'doughnut';
export type ValueLabels =
  | 'show_all'
  | 'hide_all'
  | 'total_only'
  | 'percent_only';

export const CHART_TYPES: readonly ChartType[] = [
  'bar',
  'line',
  'pie',
  'doughnut',
] as const;
export const VALUE_LABELS: readonly ValueLabels[] = [
  'show_all',
  'hide_all',
  'total_only',
  'percent_only',
] as const;

/** 系列配色顺序：只用主题色板，系列可区分且与图例一一对应。 */
export const THEME_SERIES_COLORS: readonly string[] = [
  PPT_THEME_COLORS.titleBlue,
  PPT_THEME_COLORS.brightBlue,
  PPT_THEME_COLORS.green,
  PPT_THEME_COLORS.orange,
  PPT_THEME_COLORS.lightBlue,
  PPT_THEME_COLORS.deepNavy,
] as const;

export const MAX_CATEGORIES = 50;
export const MAX_SERIES = 8;
export const MAX_TABLE_FILE_BYTES = 1_500_000;
export const MAX_KPI_CARDS = 4;

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartData {
  categories: string[];
  series: ChartSeries[];
}

export type ChartDataSourceKind = 'inline' | 'file' | 'content_source';

export interface PageSourceRefInput {
  sourceId: string;
  sourceKind: 'upload_text' | 'reference_ppt' | 'wiki_kb';
  locator: string;
}

export interface ChartSpec {
  title?: string;
  data: ChartData;
  /** 已解析的最终类型（未指定时由 autoChartType 定）。 */
  chartType: ChartType;
  /** 类型是否自动选出（生成草稿/回显中注明）。 */
  chartTypeAuto: boolean;
  valueLabels: ValueLabels;
  /** 内容源出处（kind=content_source 时必填，见 service 层校验）。 */
  pageSourceRefs?: PageSourceRefInput[];
}

export interface KpiCard {
  title: string;
  value: number;
  unit?: string;
  /** 来自同页数据的口径（与 pageSourceRefs 二选一，见 validateKpiCards）。 */
  fromData?: {
    series?: string;
    category?: string;
    agg?: 'sum' | 'value' | 'total';
  };
  pageSourceRefs?: PageSourceRefInput[];
  /** 落位（service 层由 slotId 解析或直接给 rectIn）。 */
  rectIn: RectIn;
}

export interface ChartAssignment {
  pageNo: number;
  rectIn: RectIn;
  chart: ChartSpec;
  kpiCards?: KpiCard[];
}

function fail(message: string): never {
  throw new PresentonError('invalid_input', message);
}

function escapeXml(s: string): string {
  return s
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 数值写进 XML 缓存：整数原样，小数不写科学计数法尾巴。 */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) fail('图表数据含非数字');
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10000) / 10000);
}

/** 数字卡显示：整数加千分位，小数最多两位。 */
export function fmtKpiValue(n: number): string {
  if (!Number.isFinite(n)) fail('数字卡数值须为数字');
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

// ─── 数据校验 ───────────────────────────────────────────────────────────────

/**
 * 校验图表数据。无数据（categories/series 为空、或根本没传）时明确报
 * “缺数据”，不生成示例数字（实施清单能力四：不接受“帮我编一组数”）。
 */
export function validateChartData(value: unknown): ChartData {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(
      '缺数据：请提供图表数据（类目 categories 与系列 series），不给数据无法画图，也不会编造示例数字'
    );
  const v = value as Record<string, unknown>;
  const categories = v.categories;
  const series = v.series;
  if (!Array.isArray(categories) || categories.length === 0)
    fail(
      '缺数据：请提供图表数据（类目 categories 与系列 series），不给数据无法画图，也不会编造示例数字'
    );
  if (!Array.isArray(series) || series.length === 0)
    fail(
      '缺数据：请提供图表数据（类目 categories 与系列 series），不给数据无法画图，也不会编造示例数字'
    );
  if (categories.length > MAX_CATEGORIES)
    fail(`类目最多 ${MAX_CATEGORIES} 个，当前 ${categories.length} 个`);
  if (series.length > MAX_SERIES)
    fail(`系列最多 ${MAX_SERIES} 个，当前 ${series.length} 个`);
  const cats: string[] = [];
  for (const c of categories as unknown[]) {
    if (typeof c !== 'string' || !c.trim() || c.trim().length > 100)
      fail('类目须为非空字符串（每项不超过 100 字）');
    cats.push(c.trim());
  }
  const outSeries: ChartSeries[] = [];
  for (const s of series as unknown[]) {
    if (typeof s !== 'object' || s === null || Array.isArray(s))
      fail('每个系列须为 {name, values} 对象');
    const r = s as Record<string, unknown>;
    if (
      typeof r.name !== 'string' ||
      !r.name.trim() ||
      r.name.trim().length > 100
    )
      fail('系列须有非空名称（不超过 100 字）');
    if (!Array.isArray(r.values) || r.values.length !== cats.length)
      fail(
        `系列「${String(r.name)}」的值个数（${Array.isArray(r.values) ? r.values.length : 0}）与类目个数（${cats.length}）不一致`
      );
    const values: number[] = [];
    for (const n of r.values as unknown[]) {
      if (typeof n !== 'number' || !Number.isFinite(n))
        fail(`系列「${String(r.name)}」的值须为数字`);
      values.push(n);
    }
    outSeries.push({ name: (r.name as string).trim(), values });
  }
  return { categories: cats, series: outSeries };
}

/** 类目合计（每类目各系列之和）、系列合计、总计。 */
export function categoryTotals(data: ChartData): number[] {
  return data.categories.map((_, i) =>
    data.series.reduce((n, s) => n + s.values[i], 0)
  );
}
export function seriesTotals(data: ChartData): number[] {
  return data.series.map((s) => s.values.reduce((n, v) => n + v, 0));
}
export function grandTotal(data: ChartData): number {
  return seriesTotals(data).reduce((n, v) => n + v, 0);
}

/**
 * 百分比口径（percent_only 的合计口径，与源数据一致）：
 * - 饼/环形：每片占总计（全片合计 100%）。
 * - 柱/折线：每值占其类目合计（每类目合计 100%）。
 */
export function percentages(data: ChartData, chartType: ChartType): number[][] {
  if (chartType === 'pie' || chartType === 'doughnut') {
    const total = grandTotal(data);
    return data.series.map((s) =>
      s.values.map((v) => (total === 0 ? 0 : (v / total) * 100))
    );
  }
  const totals = categoryTotals(data);
  return data.series.map((s) =>
    s.values.map((v, i) => (totals[i] === 0 ? 0 : (v / totals[i]) * 100))
  );
}

// ─── 类型自动选择与冲突提示 ─────────────────────────────────────────────────

const TIME_LABEL_RE =
  /^(19|20)\d{2}([-/.年]\d{1,2}([-/.月]\d{1,2}[日号]?)?)?$|^Q[1-4]|^[1-4]季度|^\d{1,2}月$|^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*\d{0,4}$/i;

/** 类目是否像时间（年/季度/月），是则倾向折线（趋势）。 */
export function categoriesLookLikeTime(categories: string[]): boolean {
  if (categories.length < 2) return false;
  const hits = categories.filter((c) => TIME_LABEL_RE.test(c.trim())).length;
  return hits >= Math.ceil(categories.length * 0.8);
}

/**
 * 未指定类型时的自动选择（在草稿中注明是自动选的）：
 * 单系列、≤6 类目、全非负 → 饼图（占比）；类目像时间或单系列 ≥5
 * 类目 → 折线（趋势）；其余 → 柱状（对比）。
 */
export function autoChartType(data: ChartData): {
  chartType: ChartType;
  reason: string;
} {
  const single = data.series.length === 1;
  const nonNegative = data.series.every((s) => s.values.every((v) => v >= 0));
  // 时间序列优先于占比：年份/季度/月份类目即使单系列少类目也按趋势选折线。
  // 多系列时仍是系列间对比（柱状），不按时间改折线。
  if (
    single &&
    (categoriesLookLikeTime(data.categories) || data.categories.length >= 5)
  )
    return {
      chartType: 'line',
      reason: '类目像时间序列或点数较多，按趋势自动选折线图',
    };
  if (single && data.categories.length <= 6 && nonNegative)
    return {
      chartType: 'pie',
      reason: `单系列、${data.categories.length} 个类目、数值全非负，按占比自动选饼图`,
    };
  return {
    chartType: 'bar',
    reason:
      data.series.length > 1
        ? `${data.series.length} 个系列作对比，自动选柱状图`
        : '类目作对比，自动选柱状图',
  };
}

/**
 * 指定类型与数据形态明显不合时返回提示（请确认，不静默换型）：
 * - 饼/环形只支持单系列：多系列是硬错（画不出来），不是提示。
 * - 饼/环形遇负值是硬错（占比无意义）。
 * - 饼/环形类目 >8：提示改柱状（扇区太多看不清）。
 * - 折线类目不像时间且点数 <5：提示改柱状。
 * - 柱状类目像时间且点数 ≥5：提示改折线。
 * 返回 null 表示无冲突。
 */
export function checkTypeMismatch(
  chartType: ChartType,
  data: ChartData
): { suggestedType: ChartType; reason: string } | null {
  if (chartType === 'pie' || chartType === 'doughnut') {
    if (data.series.length > 1)
      fail(
        `饼图/环形图只支持单个系列，当前 ${data.series.length} 个系列：请拆成单系列再画，或改用柱状图对比`
      );
    if (data.series.some((s) => s.values.some((v) => v < 0)))
      fail('饼图/环形图不支持负值（占比无意义）：请改用柱状图');
    if (data.categories.length > 8)
      return {
        suggestedType: 'bar',
        reason: `饼图/环形图有 ${data.categories.length} 个类目（超过 8 个扇区太多、看不清），建议改用柱状图对比；确认仍用饼图请带 confirm=true 再调`,
      };
    return null;
  }
  if (chartType === 'line') {
    if (!categoriesLookLikeTime(data.categories) && data.categories.length < 5)
      return {
        suggestedType: 'bar',
        reason: `折线图一般用于趋势（时间序列），当前类目不是时间且只有 ${data.categories.length} 个点，建议改用柱状图对比；确认仍用折线请带 confirm=true 再调`,
      };
    return null;
  }
  if (
    chartType === 'bar' &&
    categoriesLookLikeTime(data.categories) &&
    data.categories.length >= 5
  )
    return {
      suggestedType: 'line',
      reason: `类目是时间序列（${data.categories.length} 个点），趋势用折线图更合适；确认仍用柱状请带 confirm=true 再调`,
    };
  return null;
}

// ─── 表格文件解析（csv / xlsx 指定表） ──────────────────────────────────────
//
// 约定格式（写进 skill）：首行是表头（A1 为空或写“类目”，其余为系列名），
// 首列是类目，其余是数值。只认第一张表（csv 即整文件，xlsx 即 sheet1）。
// 三路来源之外不取数：这里只解析调用方当次传的文件，不读别的来源。

export interface TableFileInput {
  name: string;
  mime: string;
  base64: string;
}

function decodeTableFile(file: TableFileInput): Buffer {
  const compact = (file.base64 || '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0)
    fail(`文件「${file.name}」不是有效的 base64 内容`);
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length > MAX_TABLE_FILE_BYTES)
    fail(
      `图表数据文件「${file.name}」解码后 ${bytes.length} 字节，超过 ${MAX_TABLE_FILE_BYTES} 字节上限`
    );
  return bytes;
}

/** CSV 解析：支持引号字段与逗号/换行转义。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      pushRow();
    } else if (ch === '\n') {
      pushRow();
    } else field += ch;
  }
  pushRow();
  // 末尾空行去掉。
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === ''))
    rows.pop();
  return rows;
}

/** 表格行 → ChartData：首行表头、首列类目、其余数值。 */
function tableRowsToData(rows: string[][], what: string): ChartData {
  if (rows.length < 2) fail(`图表数据文件${what}至少要有表头行与一行数据`);
  const header = rows[0].map((c) => c.trim());
  if (header.length < 2)
    fail(
      `图表数据文件${what}格式不对：首行应为表头（首格为空或写“类目”，其余为系列名），首列为类目`
    );
  const seriesNames = header.slice(1);
  if (seriesNames.some((n) => !n))
    fail(`图表数据文件${what}格式不对：表头有空系列名`);
  const categories: string[] = [];
  const valuesBySeries: number[][] = seriesNames.map(() => []);
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every((c) => c.trim() === '')) continue;
    const cat = (row[0] ?? '').trim();
    if (!cat) fail(`图表数据文件${what}第 ${r + 1} 行类目为空`);
    categories.push(cat);
    for (let s = 0; s < seriesNames.length; s++) {
      const raw = (row[s + 1] ?? '').trim().replace(/,/g, '');
      if (raw === '' || Number.isNaN(Number(raw)))
        fail(
          `图表数据文件${what}第 ${r + 1} 行、系列「${seriesNames[s]}」的值「${row[s + 1] ?? ''}」不是数字`
        );
      valuesBySeries[s].push(Number(raw));
    }
  }
  if (categories.length === 0) fail(`图表数据文件${what}没有数据行`);
  return validateChartData({
    categories,
    series: seriesNames.map((name, i) => ({
      name,
      values: valuesBySeries[i],
    })),
  });
}

function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 最小 xlsx 读取：只认 sheet1 + sharedStrings（写出方也是此结构）。 */
function parseXlsx(bytes: Buffer, what: string): ChartData {
  const entries = readZipEntries(bytes);
  if (!entries) fail(`图表数据文件${what}不是有效的 xlsx 文件`);
  const sheetEntry = entries.find((e) => e.name === 'xl/worksheets/sheet1.xml');
  if (!sheetEntry) fail(`图表数据文件${what}里找不到第一张表（sheet1）`);
  const shared: string[] = [];
  const ssEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  if (ssEntry) {
    const ssXml = ssEntry.data.toString('utf-8');
    const siRe = /<si>(.*?)<\/si>/gs;
    let m: RegExpExecArray | null;
    while ((m = siRe.exec(ssXml)) !== null) {
      const texts: string[] = [];
      const tRe = /<t[^>]*>([^<]*)<\/t>/g;
      let t: RegExpExecArray | null;
      while ((t = tRe.exec(m[1])) !== null) texts.push(t[1]);
      shared.push(texts.join(''));
    }
  }
  const sheetXml = sheetEntry.data.toString('utf-8');
  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*>(.*?)<\/row>/gs;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(sheetXml)) !== null) {
    const cells = new Map<number, string>();
    const cRe = /<c\b([^>]*)>(.*?)<\/c>|<c\b([^>]*)\/>/gs;
    let cm: RegExpExecArray | null;
    while ((cm = cRe.exec(rm[1])) !== null) {
      const attrs = cm[1] ?? cm[3] ?? '';
      const inner = cm[2] ?? '';
      const refMatch = /r="([A-Z]+)(\d+)"/.exec(attrs);
      if (!refMatch) continue;
      const col = colLettersToIndex(refMatch[1]);
      const tMatch = /t="([^"]+)"/.exec(attrs);
      const vMatch = /<v>([^<]*)<\/v>/.exec(inner);
      const isMatch = /<is>(.*?)<\/is>/s.exec(inner);
      let value = '';
      if (tMatch?.[1] === 's' && vMatch) {
        value = shared[Number(vMatch[1])] ?? '';
      } else if (tMatch?.[1] === 'inlineStr' && isMatch) {
        const texts: string[] = [];
        const tRe = /<t[^>]*>([^<]*)<\/t>/g;
        let t: RegExpExecArray | null;
        while ((t = tRe.exec(isMatch[1])) !== null) texts.push(t[1]);
        value = texts.join('');
      } else if (vMatch) {
        value = vMatch[1];
      }
      cells.set(col, value);
    }
    if (cells.size === 0) continue;
    const maxCol = Math.max(...cells.keys());
    const row: string[] = [];
    for (let i = 0; i <= maxCol; i++) row.push(cells.get(i) ?? '');
    rows.push(row);
  }
  return tableRowsToData(rows, what);
}

/** 解析调用方当次传的 csv / xlsx 表格文件 → 结构化数据。 */
export function parseTableFile(file: TableFileInput): ChartData {
  const name = (file.name || '').split(/[\\/]/).pop() || 'file';
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const bytes = decodeTableFile(file);
  const what = `「${name}」`;
  if (ext === 'csv') {
    if (file.mime && file.mime !== 'text/csv' && file.mime !== 'text/plain')
      fail(`文件${what}的 MIME ${file.mime} 不是 csv`);
    return tableRowsToData(parseCsv(bytes.toString('utf-8')), what);
  }
  if (ext === 'xlsx') {
    if (
      file.mime &&
      file.mime !==
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
      fail(`文件${what}的 MIME ${file.mime} 不是 xlsx`);
    return parseXlsx(bytes, what);
  }
  fail(
    `图表数据文件${what}只接受 csv / xlsx（当前 .${ext || '无后缀'}），请按约定格式传表`
  );
}

// ─── 数字卡校验（Dashboard 卡图同源） ────────────────────────────────────────

/**
 * 数字卡数值必须来自 data 或内容源，不各算一套：
 * - fromData：按口径从同页 data 算出，与卡上数值比对（相对误差 ≤1e-6）。
 *   agg=sum + series → 该系列合计；agg=value + series + category →
 *   单个值；agg=sum + category → 该类目合计；agg=total → 总计。
 * - pageSourceRefs：内容源背书（service 层另校验 refs 归属调用方），
 *   本层只要求 refs 非空，不做算术比对。
 * - 两者都没有 → 拒绝（不接受“凭空写个数字卡”）。
 */
export function validateKpiCards(cards: unknown, data: ChartData): void {
  if (!Array.isArray(cards) || cards.length === 0)
    fail('数字卡列表为空：Dashboard 页至少要一张数字卡');
  if (cards.length > MAX_KPI_CARDS)
    fail(
      `一页 Dashboard 最多 ${MAX_KPI_CARDS} 张数字卡，当前 ${cards.length} 张`
    );
  for (const c of cards as unknown[]) {
    if (typeof c !== 'object' || c === null || Array.isArray(c))
      fail('每张数字卡须为对象');
    const card = c as Record<string, unknown>;
    if (
      typeof card.title !== 'string' ||
      !card.title.trim() ||
      card.title.trim().length > 60
    )
      fail('数字卡标题须为非空字符串（不超过 60 字）');
    if (typeof card.value !== 'number' || !Number.isFinite(card.value))
      fail(`数字卡「${String(card.title)}」的数值须为数字`);
    const refs = card.pageSourceRefs;
    if (Array.isArray(refs) && refs.length > 0) continue;
    const from = card.fromData;
    if (typeof from !== 'object' || from === null || Array.isArray(from))
      fail(
        `数字卡「${String(card.title)}」的数值 ${card.value} 既不在同页图表数据里、又没有内容源出处：请给 fromData（从同页数据算）或 pageSourceRefs（内容源背书）`
      );
    const f = from as Record<string, unknown>;
    const agg = f.agg === 'value' || f.agg === 'total' ? f.agg : 'sum';
    let expected: number | null = null;
    if (agg === 'total') {
      expected = grandTotal(data);
    } else if (typeof f.series === 'string') {
      const si = data.series.findIndex((s) => s.name === f.series);
      if (si < 0)
        fail(
          `数字卡「${String(card.title)}」的 fromData.series「${String(f.series)}」不在同页数据里`
        );
      if (agg === 'sum') {
        expected = data.series[si].values.reduce((n, v) => n + v, 0);
      } else {
        if (typeof f.category !== 'string')
          fail(`数字卡「${String(card.title)}」agg=value 时须同时给 category`);
        const ci = data.categories.indexOf(f.category);
        if (ci < 0)
          fail(
            `数字卡「${String(card.title)}」的 fromData.category「${String(f.category)}」不在同页数据里`
          );
        expected = data.series[si].values[ci];
      }
    } else if (typeof f.category === 'string') {
      const ci = data.categories.indexOf(f.category);
      if (ci < 0)
        fail(
          `数字卡「${String(card.title)}」的 fromData.category「${String(f.category)}」不在同页数据里`
        );
      expected = data.series.reduce((n, s) => n + s.values[ci], 0);
    } else {
      fail(
        `数字卡「${String(card.title)}」的 fromData 须指明 series 或 category（或 agg=total）`
      );
    }
    const value = card.value as number;
    const tolerance = Math.max(1e-6, Math.abs(expected) * 1e-6);
    if (Math.abs(value - expected) > tolerance)
      fail(
        `数字卡「${String(card.title)}」的数值 ${value} 与同页数据算出的 ${expected} 对不上：卡与图必须同源同数，不各算一套`
      );
  }
}
// ─── 最小 zip 写入（内嵌工作簿用；不依赖 element-index 的私有函数） ───────

function buildZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const nameBuf = Buffer.from(entry.name, 'utf-8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

function colLetter(index0: number): string {
  // 0 → A，25 → Z，26 → AA。
  let n = index0 + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * 内嵌 xlsx 工作簿（图表的数据源）：Sheet1 首行表头（A1 留空，B1.. 为
 * 系列名），首列类目，其余数值；字符串走 sharedStrings。PowerPoint
 * 双击图表 → “编辑数据”打开的就是这份工作簿，改数即改图。
 */
export function buildEmbeddedWorkbook(data: ChartData): Buffer {
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const si = (s: string): number => {
    const hit = stringIndex.get(s);
    if (hit !== undefined) return hit;
    const idx = strings.length;
    strings.push(s);
    stringIndex.set(s, idx);
    return idx;
  };
  // A1 留空；B1.. 系列名；A2.. 类目。
  const headerCells = data.series
    .map((s, i) => `<c r="${colLetter(i + 1)}1" t="s"><v>${si(s.name)}</v></c>`)
    .join('');
  const rows: string[] = [`<row r="1">${headerCells}</row>`];
  data.categories.forEach((cat, ri) => {
    const cells = [
      `<c r="A${ri + 2}" t="s"><v>${si(cat)}</v></c>`,
      ...data.series.map(
        (s, si2) =>
          `<c r="${colLetter(si2 + 1)}${ri + 2}"><v>${fmtNum(s.values[ri])}</v></c>`
      ),
    ].join('');
    rows.push(`<row r="${ri + 2}">${cells}</row>`);
  });
  const text = (s: string) => Buffer.from(s, 'utf-8');
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`;
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${escapeXml(s)}</t></si>`).join('')}</sst>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return buildZip([
    { name: '[Content_Types].xml', data: text(contentTypes) },
    { name: '_rels/.rels', data: text(rels) },
    { name: 'xl/workbook.xml', data: text(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: text(workbookRels) },
    { name: 'xl/worksheets/sheet1.xml', data: text(sheet) },
    { name: 'xl/sharedStrings.xml', data: text(sharedStrings) },
    { name: 'xl/styles.xml', data: text(styles) },
  ]);
}

/** 从内嵌工作簿读回数据（chart_update 换类型/只改标签时复用原数据）。 */
export function readWorkbookData(bytes: Buffer): ChartData | null {
  const entries = readZipEntries(bytes);
  if (!entries) return null;
  const sheetEntry = entries.find((e) => e.name === 'xl/worksheets/sheet1.xml');
  if (!sheetEntry) return null;
  const shared: string[] = [];
  const ssEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  if (ssEntry) {
    const ssXml = ssEntry.data.toString('utf-8');
    const siRe = /<si>(.*?)<\/si>/gs;
    let m: RegExpExecArray | null;
    while ((m = siRe.exec(ssXml)) !== null) {
      const texts: string[] = [];
      const tRe = /<t[^>]*>([^<]*)<\/t>/g;
      let t: RegExpExecArray | null;
      while ((t = tRe.exec(m[1])) !== null) texts.push(t[1]);
      shared.push(texts.join(''));
    }
  }
  const sheetXml = sheetEntry.data.toString('utf-8');
  const rows: Array<Map<number, string>> = [];
  const rowRe = /<row\b[^>]*>(.*?)<\/row>/gs;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(sheetXml)) !== null) {
    const cells = new Map<number, string>();
    const cRe = /<c\b([^>]*)>(.*?)<\/c>|<c\b([^>]*)\/>/gs;
    let cm: RegExpExecArray | null;
    while ((cm = cRe.exec(rm[1])) !== null) {
      const attrs = cm[1] ?? cm[3] ?? '';
      const inner = cm[2] ?? '';
      const refMatch = /r="([A-Z]+)(\d+)"/.exec(attrs);
      if (!refMatch) continue;
      const col = colLettersToIndex(refMatch[1]);
      const tMatch = /t="([^"]+)"/.exec(attrs);
      const vMatch = /<v>([^<]*)<\/v>/.exec(inner);
      if (!vMatch) continue;
      cells.set(
        col,
        tMatch?.[1] === 's' ? (shared[Number(vMatch[1])] ?? '') : vMatch[1]
      );
    }
    rows.push(cells);
  }
  if (rows.length < 2) return null;
  const header = rows[0];
  const seriesNames: string[] = [];
  for (let c = 1; c <= Math.max(...rows[0].keys()); c++) {
    const name = header.get(c);
    if (name !== undefined && name !== '') seriesNames.push(name);
  }
  if (seriesNames.length === 0) return null;
  const categories: string[] = [];
  const valuesBySeries: number[][] = seriesNames.map(() => []);
  for (let r = 1; r < rows.length; r++) {
    const cat = rows[r].get(0);
    if (cat === undefined || cat === '') continue;
    categories.push(cat);
    for (let s = 0; s < seriesNames.length; s++) {
      const raw = rows[r].get(s + 1);
      const n = raw === undefined || raw === '' ? NaN : Number(raw);
      if (!Number.isFinite(n)) return null;
      valuesBySeries[s].push(n);
    }
  }
  if (categories.length === 0) return null;
  try {
    return validateChartData({
      categories,
      series: seriesNames.map((name, i) => ({
        name,
        values: valuesBySeries[i],
      })),
    });
  } catch {
    return null;
  }
}
// ─── 图表 XML（c:chart） ────────────────────────────────────────────────────
//
// 引用约定：系列 i（0 起）的数据在工作簿第 i+2 列（B 起），行 2..N+1；
// 类目在 A 列 2..N+1；系列名在第 1 行。缓存（strCache/numCache）与引用
// 一致写，PowerPoint 不依赖缓存也能读，但缓存让“不打开工作簿也能看
// 到数”，且是 chart_update 读回数据的另一条路。

const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function strCache(values: string[]): string {
  return `<c:strCache><c:ptCount val="${values.length}"/>${values
    .map((v, i) => `<c:pt idx="${i}"><c:v>${escapeXml(v)}</c:v></c:pt>`)
    .join('')}</c:strCache>`;
}

function numCache(values: number[]): string {
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${values
    .map((v, i) => `<c:pt idx="${i}"><c:v>${fmtNum(v)}</c:v></c:pt>`)
    .join('')}</c:numCache>`;
}

function strRef(range: string, values: string[]): string {
  return `<c:strRef><c:f>${range}</c:f>${strCache(values)}</c:strRef>`;
}

function numRef(range: string, values: number[]): string {
  return `<c:numRef><c:f>${range}</c:f>${numCache(values)}</c:numRef>`;
}

function catRef(data: ChartData): string {
  return strRef(
    `Sheet1!$A$2:$A$${data.categories.length + 1}`,
    data.categories
  );
}

function valRef(seriesIndex: number, data: ChartData): string {
  const col = colLetter(seriesIndex + 1);
  return numRef(
    `Sheet1!$${col}$2:$${col}$${data.categories.length + 1}`,
    data.series[seriesIndex].values
  );
}

function txRef(seriesIndex: number, data: ChartData): string {
  const col = colLetter(seriesIndex + 1);
  return `<c:tx>${strRef(`Sheet1!$${col}$1`, [data.series[seriesIndex].name])}</c:tx>`;
}

function hexNoHash(hex: string): string {
  return hex.replace(/^#/, '').toUpperCase();
}

/**
 * 数据标签（只改标签层）：
 * - show_all：每点显示数值。
 * - hide_all：不显示任何标签。
 * - percent_only：每点显示百分比（口径见 percentages：饼按总计，
 *   柱/折线按类目合计；PowerPoint 按同一口径现算）。
 * - total_only：柱/折线在每类目的最后一个系列上显示该类目合计，
 *   饼/环形在第一个扇区上显示总计；合计数字以逐点标签文本
 *   （c:dLbl/c:tx/c:rich）写在标签层，底层数据不动。
 */
function dLblsXml(
  valueLabels: ValueLabels,
  opts: {
    seriesIndex: number;
    isLastSeries: boolean;
    chartType: ChartType;
    data: ChartData;
  }
): string {
  const { seriesIndex, isLastSeries, chartType, data } = opts;
  const pos =
    chartType === 'pie' || chartType === 'doughnut' ? 'bestFit' : 'outEnd';
  const flags = (o: { val: boolean; percent: boolean }): string =>
    `<c:showLegendKey val="0"/><c:showVal val="${o.val ? 1 : 0}"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="${o.percent ? 1 : 0}"/><c:showBubbleSize val="0"/>`;
  let pointLabels = '';
  if (valueLabels === 'total_only') {
    if ((chartType === 'bar' || chartType === 'line') && isLastSeries) {
      const totals = categoryTotals(data);
      pointLabels = totals
        .map(
          (t, i) =>
            `<c:dLbl><c:idx val="${i}"/><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="900"/><a:t>${escapeXml(fmtNum(t))}</a:t></a:r></a:p></c:rich></c:tx>${flags({ val: false, percent: false })}</c:dLbl>`
        )
        .join('');
    } else if (
      (chartType === 'pie' || chartType === 'doughnut') &&
      seriesIndex === 0
    ) {
      const total = grandTotal(data);
      pointLabels = `<c:dLbl><c:idx val="0"/><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="900"/><a:t>${escapeXml(fmtNum(total))}</a:t></a:r></a:p></c:rich></c:tx>${flags({ val: false, percent: false })}</c:dLbl>`;
    }
  }
  switch (valueLabels) {
    case 'show_all':
      return `<c:dLbls><c:dLblPos val="${pos}"/>${flags({ val: true, percent: false })}</c:dLbls>`;
    case 'percent_only':
      return `<c:dLbls><c:dLblPos val="${pos}"/>${flags({ val: false, percent: true })}</c:dLbls>`;
    case 'hide_all':
      return `<c:dLbls><c:dLblPos val="${pos}"/>${flags({ val: false, percent: false })}</c:dLbls>`;
    case 'total_only':
      return `<c:dLbls>${pointLabels}<c:dLblPos val="${pos}"/>${flags({ val: false, percent: false })}</c:dLbls>`;
  }
}

function seriesXml(seriesIndex: number, spec: ChartSpec): string {
  const { data, chartType, valueLabels } = spec;
  const series = data.series[seriesIndex];
  const color = hexNoHash(
    THEME_SERIES_COLORS[seriesIndex % THEME_SERIES_COLORS.length]
  );
  const labels = dLblsXml(valueLabels, {
    seriesIndex,
    isLastSeries: seriesIndex === data.series.length - 1,
    chartType,
    data,
  });
  const commonHead =
    `<c:idx val="${seriesIndex}"/><c:order val="${seriesIndex}"/>` +
    txRef(seriesIndex, data);
  if (chartType === 'bar') {
    return (
      `<c:ser>${commonHead}` +
      `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr>` +
      `${labels}<c:cat>${catRef(data)}</c:cat><c:val>${valRef(seriesIndex, data)}</c:val></c:ser>`
    );
  }
  if (chartType === 'line') {
    return (
      `<c:ser>${commonHead}` +
      `<c:spPr><a:ln w="28575"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr>` +
      `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr></c:marker>` +
      `${labels}<c:cat>${catRef(data)}</c:cat><c:val>${valRef(seriesIndex, data)}</c:val><c:smooth val="0"/></c:ser>`
    );
  }
  // 饼/环形：每片单独着色（dPt），与图例一一对应。
  const points = series.values
    .map((_, i) => {
      const sliceColor = hexNoHash(
        THEME_SERIES_COLORS[i % THEME_SERIES_COLORS.length]
      );
      return `<c:dPt><c:idx val="${i}"/><c:spPr><a:solidFill><a:srgbClr val="${sliceColor}"/></a:solidFill></c:spPr></c:dPt>`;
    })
    .join('');
  return (
    `<c:ser>${commonHead}${points}` +
    `${labels}<c:cat>${catRef(data)}</c:cat><c:val>${valRef(seriesIndex, data)}</c:val></c:ser>`
  );
}

function axesXml(): string {
  const txPr = `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr><a:endParaRPr lang="zh-CN"/></a:p></c:txPr>`;
  return (
    `<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/><c:crosses val="autoZero"/><c:tickLblPos val="nextTo"/>${txPr}</c:catAx>` +
    `<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorGridlines/><c:crossAx val="1"/><c:crosses val="autoZero"/><c:crossBetween val="between"/><c:tickLblPos val="nextTo"/>${txPr}</c:valAx>`
  );
}

function titleXml(title: string | undefined): string {
  if (!title) return '<c:autoTitleDeleted val="1"/>';
  return (
    `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="1"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="1400" b="1"><a:solidFill><a:srgbClr val="${hexNoHash(PPT_THEME_COLORS.titleBlue)}"/></a:solidFill></a:rPr><a:t>${escapeXml(title)}</a:t></a:r></a:p></c:rich></c:tx><c:layout/><c:overlay val="0"/></c:title>` +
    '<c:autoTitleDeleted val="0"/>'
  );
}

/** 完整 chart 部件 XML（externalData 的 r:id 由插入时传入）。 */
export function buildChartXml(spec: ChartSpec, externalRid: string): string {
  const { data, chartType } = spec;
  const sers = data.series.map((_, i) => seriesXml(i, spec)).join('');
  let plot: string;
  if (chartType === 'bar') {
    plot =
      `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${sers}<c:gapWidth val="150"/><c:overlap val="0"/><c:axId val="1"/><c:axId val="2"/></c:barChart>` +
      axesXml();
  } else if (chartType === 'line') {
    plot =
      `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}<c:marker val="1"/><c:smooth val="0"/><c:axId val="1"/><c:axId val="2"/></c:lineChart>` +
      axesXml();
  } else if (chartType === 'pie') {
    plot = `<c:pieChart><c:varyColors val="1"/>${sers}<c:firstSliceAng val="0"/></c:pieChart>`;
  } else {
    plot = `<c:doughnutChart><c:varyColors val="1"/>${sers}<c:holeSize val="50"/><c:firstSliceAng val="0"/></c:doughnutChart>`;
  }
  return (
    `<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">` +
    '<c:date1904 val="0"/><c:lang val="zh-CN"/><c:roundedCorners val="0"/>' +
    `<c:chart>${titleXml(spec.title)}<c:plotArea><c:layout/>${plot}</c:plotArea>` +
    '<c:legend><c:legendPos val="b"/><c:layout/><c:overlay val="0"/></c:legend>' +
    '<c:plotVisOnly val="1"/></c:chart>' +
    `<c:txPr><a:bodyPr/><a:lstStyle/></c:txPr>` +
    `<c:externalData r:id="${externalRid}"/></c:chartSpace>`
  );
}
// ─── zip 手术：插入 / 更新图表 ──────────────────────────────────────────────

const EMU_PER_INCH = 914400;
const CHART_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CHART_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';
const EXTERNAL_DATA_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalData';

function chartFail(message: string): never {
  throw new PresentonError('presenton_error', message);
}

/**
 * locateChart 的失败都是调用方输入问题（页不存在、元素不存在、元素
 * 不是图表、部件/关系丢失），按 400 invalid_input 回，不走 502。
 */
function chartInputFail(message: string): never {
  throw new PresentonError('invalid_input', message);
}

function slideNameFor(pageNo: number): string {
  return `ppt/slides/slide${pageNo}.xml`;
}

function slideRelsNameFor(pageNo: number): string {
  return `ppt/slides/_rels/slide${pageNo}.xml.rels`;
}

function nextNumbered(names: string[], prefix: string): number {
  let max = 0;
  for (const name of names) {
    const m = new RegExp(
      `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)\\.xml$`
    ).exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function nextRid(relsXml: string): string {
  let max = 0;
  for (const m of relsXml.matchAll(/Id="rId(\d+)"/g))
    max = Math.max(max, Number(m[1]));
  return `rId${max + 1}`;
}

function maxCnvPrId(slideXml: string): number {
  let max = 0;
  for (const m of slideXml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/g))
    max = Math.max(max, Number(m[1]));
  return max;
}

function elementIdFor(pageNo: number, ordinal: number): string {
  return `el-p${pageNo}-${ordinal}`;
}

/** 其余页逐字节不变的自检（插入/更新共用）。 */
function assertOtherSlidesUnchanged(
  before: Buffer,
  after: Buffer,
  changedSlide: string,
  extraChanged: string[]
): void {
  const beforeEntries = readZipEntries(before);
  const afterEntries = readZipEntries(after);
  if (!beforeEntries || !afterEntries) chartFail('图表写回后无法读回文件');
  const changed = new Set([changedSlide, ...extraChanged]);
  for (const entry of beforeEntries) {
    if (changed.has(entry.name)) continue;
    const found = afterEntries.find((e) => e.name === entry.name);
    if (!found || !found.data.equals(entry.data))
      chartFail(`图表写回异常：${entry.name} 被意外改动`);
  }
}

function graphicFrameXml(
  elementId: string,
  cnvPrId: number,
  rid: string,
  rectIn: RectIn
): string {
  const off = `<a:off x="${Math.round(rectIn.x * EMU_PER_INCH)}" y="${Math.round(rectIn.y * EMU_PER_INCH)}"/>`;
  const ext = `<a:ext cx="${Math.round(rectIn.width * EMU_PER_INCH)}" cy="${Math.round(rectIn.height * EMU_PER_INCH)}"/>`;
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${cnvPrId}" name="${elementId}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm>${off}${ext}</p:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="${C_NS}" xmlns:r="${R_NS}" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

/**
 * 在指定页、指定矩形插入一个原生图表。返回新字节、图表元素 id 与部件名。
 * 只改目标 slide XML（+ 新增 chart / workbook / rels / Content_Types
 * 条目），其余 slide 解压后内容逐字节不变（自检保证）。
 */
export function insertChart(
  pptx: Buffer,
  pageNo: number,
  rectIn: RectIn,
  spec: ChartSpec
): { bytes: Buffer; elementId: string; chartPart: string } {
  const entries = readZipEntries(pptx);
  if (!entries) chartFail('无法读取 PPTX 文件');
  const slideName = slideNameFor(pageNo);
  const slideEntry = entries.find((e) => e.name === slideName);
  if (!slideEntry) chartFail(`第 ${pageNo} 页不存在`);
  const index = buildElementIndex(pptx);
  const page = index?.pages.find((p) => p.pageNo === pageNo);
  if (!page) chartFail(`第 ${pageNo} 页不存在`);
  const slideXml = slideEntry.data.toString('utf-8');
  const ordinal = page.elements.length + 1;
  const elementId = elementIdFor(pageNo, ordinal);
  const chartNo = nextNumbered(
    entries.map((e) => e.name),
    'ppt/charts/chart'
  );
  const chartPart = `ppt/charts/chart${chartNo}.xml`;
  const chartRelsPart = `ppt/charts/_rels/chart${chartNo}.xml.rels`;
  // 内嵌工作簿文件名：避开已有的同名部件。
  const existingEmbeddings = new Set(
    entries.map((e) => e.name).filter((n) => n.startsWith('ppt/embeddings/'))
  );
  let wbName = 'Microsoft_Excel_Worksheet.xlsx';
  let wbCounter = 2;
  while (existingEmbeddings.has(`ppt/embeddings/${wbName}`)) {
    wbName = `Microsoft_Excel_Worksheet${wbCounter}.xlsx`;
    wbCounter += 1;
  }
  const workbookPart = `ppt/embeddings/${wbName}`;
  // slide rels：补一条 chart 关系；rels 文件不存在时新建。
  const relsName = slideRelsNameFor(pageNo);
  const relsEntry = entries.find((e) => e.name === relsName);
  let relsXml =
    relsEntry?.data.toString('utf-8') ??
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const chartRid = nextRid(relsXml);
  const relLine = `<Relationship Id="${chartRid}" Type="${CHART_REL_TYPE}" Target="../charts/chart${chartNo}.xml"/>`;
  if (relsXml.includes('</Relationships>'))
    relsXml = relsXml.replace('</Relationships>', `${relLine}</Relationships>`);
  else relsXml = `${relsXml}${relLine}`;
  // chart rels：externalData → 内嵌工作簿。
  const chartRelsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${EXTERNAL_DATA_REL_TYPE}" Target="../embeddings/${wbName}"/></Relationships>`;
  // Content_Types：补 chart Override 与 xlsx Default。
  const ctEntry = entries.find((e) => e.name === '[Content_Types].xml');
  if (!ctEntry) chartFail('PPTX 缺少 [Content_Types].xml');
  let ctXml = ctEntry.data.toString('utf-8');
  const chartOverride = `<Override PartName="/ppt/charts/chart${chartNo}.xml" ContentType="${CHART_CONTENT_TYPE}"/>`;
  if (!ctXml.includes(`/ppt/charts/chart${chartNo}.xml`))
    ctXml = ctXml.replace('</Types>', `${chartOverride}</Types>`);
  if (!ctXml.includes('Extension="xlsx"'))
    ctXml = ctXml.replace(
      '</Types>',
      `<Default Extension="xlsx" ContentType="${XLSX_CONTENT_TYPE}"/></Types>`
    );
  // slide 里追加 graphicFrame（末尾追加，序号与 element_id 体系一致）。
  const frame = graphicFrameXml(
    elementId,
    maxCnvPrId(slideXml) + 1,
    chartRid,
    rectIn
  );
  const closeIdx = slideXml.indexOf('</p:spTree>');
  if (closeIdx < 0) chartFail('页面 XML 结构损坏：缺少 spTree 结束标签');
  const newSlideXml =
    slideXml.slice(0, closeIdx) + frame + slideXml.slice(closeIdx);
  const chartXml = buildChartXml(spec, 'rId1');
  const workbookBytes = buildEmbeddedWorkbook(spec.data);
  let bytes: Buffer | null = replaceZipEntry(
    pptx,
    slideName,
    Buffer.from(newSlideXml, 'utf-8')
  );
  if (!bytes) chartFail('图表插入失败：无法写回页面');
  if (relsEntry) {
    bytes = replaceZipEntry(bytes, relsName, Buffer.from(relsXml, 'utf-8'));
    if (!bytes) chartFail('图表插入失败：无法写回页面关系文件');
  } else {
    bytes = addZipEntries(bytes, [
      { name: relsName, data: Buffer.from(relsXml, 'utf-8') },
    ]);
    if (!bytes) chartFail('图表插入失败：无法写回页面关系文件');
  }
  bytes = replaceZipEntry(
    bytes,
    '[Content_Types].xml',
    Buffer.from(ctXml, 'utf-8')
  );
  if (!bytes) chartFail('图表插入失败：无法写回 Content_Types');
  bytes = addZipEntries(bytes, [
    { name: chartPart, data: Buffer.from(chartXml, 'utf-8') },
    { name: chartRelsPart, data: Buffer.from(chartRelsXml, 'utf-8') },
    { name: workbookPart, data: workbookBytes },
  ]);
  if (!bytes) chartFail('图表插入失败：无法写入图表部件');
  // 自检：新元素在索引里是 chart；其余页不变；工作簿读回与入参一致。
  const checkIndex = buildElementIndex(bytes);
  const checkPage = checkIndex?.pages.find((p) => p.pageNo === pageNo);
  const checkEl = checkPage?.elements.find((e) => e.elementId === elementId);
  if (!checkEl || checkEl.type !== 'chart')
    chartFail('图表插入失败：写回后读不到新图表元素');
  assertOtherSlidesUnchanged(pptx, bytes, slideName, [
    '[Content_Types].xml',
    relsName,
    chartPart,
    chartRelsPart,
    workbookPart,
  ]);
  const wbBack = readZipEntry(bytes, workbookPart);
  const dataBack = wbBack ? readWorkbookData(wbBack) : null;
  if (!dataBack || JSON.stringify(dataBack) !== JSON.stringify(spec.data))
    chartFail('图表插入失败：内嵌工作簿读回的数据与入参不一致');
  return { bytes, elementId, chartPart };
}

// ─── 定位已有图表 ───────────────────────────────────────────────────────────

interface LocatedChart {
  chartPart: string;
  workbookPart: string;
  chartXml: string;
  externalRid: string;
  workbookBytes: Buffer;
  chartType: ChartType;
  valueLabels: ValueLabels;
  title: string | undefined;
  data: ChartData;
}

function detectChartType(chartXml: string): ChartType | null {
  if (chartXml.includes('<c:barChart')) return 'bar';
  if (chartXml.includes('<c:lineChart')) return 'line';
  if (chartXml.includes('<c:pieChart')) return 'pie';
  if (chartXml.includes('<c:doughnutChart')) return 'doughnut';
  return null;
}

function detectValueLabels(chartXml: string): ValueLabels {
  // total_only 的逐点标签只在最后一个系列（柱/折线）或第一个扇区
  // （饼/环形）上：任一 dLbls 里有带 <c:tx> 的逐点标签即 total_only。
  const dLblsRe = /<c:dLbls>(.*?)<\/c:dLbls>/gs;
  let m: RegExpExecArray | null;
  let first: string | null = null;
  while ((m = dLblsRe.exec(chartXml)) !== null) {
    if (first === null) first = m[1];
    if (/<c:dLbl><c:idx/.test(m[1]) && m[1].includes('<c:tx>'))
      return 'total_only';
  }
  if (first === null) return 'hide_all';
  if (/<c:showPercent val="1"\/>/.test(first)) return 'percent_only';
  if (/<c:showVal val="1"\/>/.test(first)) return 'show_all';
  return 'hide_all';
}

function extractChartTitle(chartXml: string): string | undefined {
  const titleMatch = /<c:title>(.*?)<\/c:title>/s.exec(chartXml);
  if (!titleMatch) return undefined;
  const tMatch = /<a:t>([^<]*)<\/a:t>/.exec(titleMatch[1]);
  return tMatch ? tMatch[1] : undefined;
}

function resolveRelTarget(relsXml: string, rid: string): string | null {
  const m = new RegExp(
    `<Relationship\\b[^>]*\\bId="${rid}"[^>]*\\bTarget="([^"]+)"`
  ).exec(relsXml);
  return m ? m[1] : null;
}

/** 把 slide 内的相对 Target（如 ../charts/chart1.xml）解成部件名。 */
function resolvePartPath(fromPart: string, target: string): string {
  const dir = fromPart.slice(0, fromPart.lastIndexOf('/'));
  const parts = dir.split('/');
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

function locateChart(
  pptx: Buffer,
  pageNo: number,
  elementId: string
): LocatedChart {
  const entries = readZipEntries(pptx);
  if (!entries) chartInputFail('无法读取 PPTX 文件');
  const slideName = slideNameFor(pageNo);
  const slideEntry = entries.find((e) => e.name === slideName);
  if (!slideEntry) chartInputFail(`第 ${pageNo} 页不存在`);
  const slideXml = slideEntry.data.toString('utf-8');
  const m = /^el-p(\d+)-(\d+)$/.exec(elementId);
  if (!m || Number(m[1]) !== pageNo)
    chartInputFail(`元素 ${elementId} 不在第 ${pageNo} 页`);
  const spans = scanShapeSpans(slideXml);
  const span = spans.find((s) => s.ordinal === Number(m[2]));
  if (!span) chartInputFail(`第 ${pageNo} 页没有元素 ${elementId}`);
  if (span.kind !== 'frame')
    chartInputFail(
      `元素 ${elementId} 不是图表（是${span.kind === 'pic' ? '图片' : '文字/形状'}），不能改图表`
    );
  const spanXml = slideXml.slice(span.start, span.end);
  const chartRidMatch = /<c:chart\b[^>]*\br:id="(rId\d+)"/.exec(spanXml);
  if (!chartRidMatch)
    chartInputFail(`元素 ${elementId} 是图框但不是图表，不能改图表`);
  const relsEntry = entries.find((e) => e.name === slideRelsNameFor(pageNo));
  if (!relsEntry) chartInputFail(`第 ${pageNo} 页缺少关系文件，找不到图表部件`);
  const relsXml = relsEntry.data.toString('utf-8');
  const chartTarget = resolveRelTarget(relsXml, chartRidMatch[1]);
  if (!chartTarget) chartInputFail(`元素 ${elementId} 的图表关系丢失`);
  const chartPart = resolvePartPath(slideName, chartTarget);
  const chartEntry = entries.find((e) => e.name === chartPart);
  if (!chartEntry)
    chartInputFail(`元素 ${elementId} 的图表部件 ${chartPart} 丢失`);
  const chartXml = chartEntry.data.toString('utf-8');
  const chartType = detectChartType(chartXml);
  if (!chartType) chartInputFail(`元素 ${elementId} 的图表类型无法识别`);
  const extMatch = /<c:externalData\b[^>]*\br:id="(rId\d+)"/.exec(chartXml);
  if (!extMatch) chartInputFail(`元素 ${elementId} 的图表没有内嵌数据`);
  const chartRelsName = `ppt/charts/_rels/${chartPart.split('/').pop()}.rels`;
  const chartRelsEntry = entries.find((e) => e.name === chartRelsName);
  if (!chartRelsEntry)
    chartInputFail(`元素 ${elementId} 的图表关系文件丢失，找不到内嵌数据`);
  const wbTarget = resolveRelTarget(
    chartRelsEntry.data.toString('utf-8'),
    extMatch[1]
  );
  if (!wbTarget) chartInputFail(`元素 ${elementId} 的内嵌数据关系丢失`);
  const workbookPart = resolvePartPath(chartPart, wbTarget);
  const wbEntry = entries.find((e) => e.name === workbookPart);
  if (!wbEntry)
    chartInputFail(`元素 ${elementId} 的内嵌数据 ${workbookPart} 丢失`);
  const data = readWorkbookData(wbEntry.data);
  if (!data) chartInputFail(`元素 ${elementId} 的内嵌数据无法读取`);
  return {
    chartPart,
    workbookPart,
    chartXml,
    externalRid: extMatch[1],
    workbookBytes: wbEntry.data,
    chartType,
    valueLabels: detectValueLabels(chartXml),
    title: extractChartTitle(chartXml),
    data,
  };
}

/** 读一图的信息（类型、标签模式、数据、标题、部件名），供更新与回显用。 */
export function readChartInfo(
  pptx: Buffer,
  pageNo: number,
  elementId: string
): {
  chartType: ChartType;
  valueLabels: ValueLabels;
  data: ChartData;
  title: string | undefined;
  chartPart: string;
  workbookPart: string;
} {
  const located = locateChart(pptx, pageNo, elementId);
  return {
    chartType: located.chartType,
    valueLabels: located.valueLabels,
    data: located.data,
    title: located.title,
    chartPart: located.chartPart,
    workbookPart: located.workbookPart,
  };
}

export interface ChartUpdate {
  /** 换数据（须走三路来源校验后的已解析数据）。 */
  data?: ChartData;
  chartType?: ChartType;
  valueLabels?: ValueLabels;
  /** 换标题；传空字符串表示去掉标题；不传则保留原标题。 */
  title?: string;
}

/**
 * 改已有图表：换数据、换类型、切数值标签显隐。
 * - 只换标签时：图表 XML 按同一 builder 从原数据重建（坐标轴与数据引用
 *   不变），工作簿不动。
 * - 换数据/类型时：图表 XML 重建；换数据时工作簿也重建。
 * - 只动该图表的部件（chart XML + 必要时 workbook），slide XML 不动，
 *   其余页逐字节不变（自检保证）。
 * 注意：Presenton 原生图表经本接口改过后，部件按 wiki 主题色重建
 * （数据不变），不是原 Presenton 样式。
 */
export function updateChart(
  pptx: Buffer,
  pageNo: number,
  elementId: string,
  update: ChartUpdate
): {
  bytes: Buffer;
  chartType: ChartType;
  valueLabels: ValueLabels;
} {
  const located = locateChart(pptx, pageNo, elementId);
  const newData = update.data ?? located.data;
  const newType = update.chartType ?? located.chartType;
  const newLabels = update.valueLabels ?? located.valueLabels;
  const newTitle =
    update.title !== undefined ? update.title || undefined : located.title;
  if (update.data) validateChartData(newData);
  if (update.chartType || update.data) {
    // 硬错（多系列饼图、饼图负值）直接拒绝，不静默换型。
    checkTypeMismatch(newType, newData);
  }
  const spec: ChartSpec = {
    ...(newTitle ? { title: newTitle } : {}),
    data: newData,
    chartType: newType,
    chartTypeAuto: false,
    valueLabels: newLabels,
  };
  const newChartXml = buildChartXml(spec, located.externalRid);
  let bytes: Buffer | null = replaceZipEntry(
    pptx,
    located.chartPart,
    Buffer.from(newChartXml, 'utf-8')
  );
  if (!bytes) chartFail('图表更新失败：无法写回图表部件');
  const changedParts = [located.chartPart];
  if (update.data) {
    bytes = replaceZipEntry(
      bytes,
      located.workbookPart,
      buildEmbeddedWorkbook(newData)
    );
    if (!bytes) chartFail('图表更新失败：无法写回内嵌数据');
    changedParts.push(located.workbookPart);
  }
  assertOtherSlidesUnchanged(pptx, bytes, slideNameFor(pageNo), changedParts);
  const back = readChartInfo(bytes, pageNo, elementId);
  if (
    back.chartType !== newType ||
    back.valueLabels !== newLabels ||
    JSON.stringify(back.data) !== JSON.stringify(newData)
  )
    chartFail('图表更新失败：写回后读到的图表与目标不一致');
  return { bytes, chartType: newType, valueLabels: newLabels };
}

// ─── 数字卡（Dashboard） ────────────────────────────────────────────────────

/**
 * 在指定页插入数字卡形状：深海军蓝底（与 11 月单页底部深蓝数据条一致）、
 * 白字、标题 12pt、数值 26pt 加粗。形状追加在 spTree 末尾，元素 id 按
 * 出现顺序续排；只改目标 slide XML，其余页不变。
 */
export function insertKpiCards(
  pptx: Buffer,
  pageNo: number,
  cards: KpiCard[]
): { bytes: Buffer; elementIds: string[] } {
  const entries = readZipEntries(pptx);
  if (!entries) chartFail('无法读取 PPTX 文件');
  const slideName = slideNameFor(pageNo);
  const slideEntry = entries.find((e) => e.name === slideName);
  if (!slideEntry) chartFail(`第 ${pageNo} 页不存在`);
  const index = buildElementIndex(pptx);
  const page = index?.pages.find((p) => p.pageNo === pageNo);
  if (!page) chartFail(`第 ${pageNo} 页不存在`);
  let slideXml = slideEntry.data.toString('utf-8');
  let maxId = maxCnvPrId(slideXml);
  let ordinal = page.elements.length;
  const elementIds: string[] = [];
  const shapes: string[] = [];
  for (const card of cards) {
    ordinal += 1;
    maxId += 1;
    const elementId = elementIdFor(pageNo, ordinal);
    elementIds.push(elementId);
    const r = card.rectIn;
    const off = `<a:off x="${Math.round(r.x * EMU_PER_INCH)}" y="${Math.round(r.y * EMU_PER_INCH)}"/>`;
    const ext = `<a:ext cx="${Math.round(r.width * EMU_PER_INCH)}" cy="${Math.round(r.height * EMU_PER_INCH)}"/>`;
    const valueText = `${fmtKpiValue(card.value)}${card.unit ? ` ${card.unit}` : ''}`;
    shapes.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${maxId}" name="${elementId}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm>${off}${ext}</a:xfrm><a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${hexNoHash(PPT_THEME_COLORS.deepNavy)}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>` +
        `<p:txBody><a:bodyPr wrap="square" anchor="ctr"/><a:lstStyle/>` +
        `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="1200"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>${escapeXml(card.title)}</a:t></a:r></a:p>` +
        `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="2600" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>${escapeXml(valueText)}</a:t></a:r></a:p>` +
        `</p:txBody></p:sp>`
    );
  }
  const closeIdx = slideXml.indexOf('</p:spTree>');
  if (closeIdx < 0) chartFail('页面 XML 结构损坏：缺少 spTree 结束标签');
  slideXml =
    slideXml.slice(0, closeIdx) + shapes.join('') + slideXml.slice(closeIdx);
  const bytes = replaceZipEntry(
    pptx,
    slideName,
    Buffer.from(slideXml, 'utf-8')
  );
  if (!bytes) chartFail('数字卡插入失败：无法写回页面');
  assertOtherSlidesUnchanged(pptx, bytes, slideName, []);
  const checkIndex = buildElementIndex(bytes);
  const checkPage = checkIndex?.pages.find((p) => p.pageNo === pageNo);
  for (const elementId of elementIds) {
    const el = checkPage?.elements.find((e) => e.elementId === elementId);
    if (!el || el.type !== 'text')
      chartFail('数字卡插入失败：写回后读不到新数字卡元素');
  }
  return { bytes, elementIds };
}

// ─── 任务行 chart_assignments 的解析（生成时写入，见 service.ts） ──────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRectInLike(value: unknown): value is RectIn {
  if (!isRecord(value)) return false;
  return (
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number'
  );
}

/** 校验并解析 presentation_job.chart_assignments；结构不对返回 null。 */
export function parseChartAssignments(
  value: string | null | undefined
): ChartAssignment[] | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: ChartAssignment[] = [];
  for (const item of parsed as unknown[]) {
    if (!isRecord(item)) return null;
    if (
      typeof item.pageNo !== 'number' ||
      !Number.isInteger(item.pageNo) ||
      item.pageNo < 1
    )
      return null;
    if (!isRectInLike(item.rectIn)) return null;
    if (!isRecord(item.chart)) return null;
    const c = item.chart as Record<string, unknown>;
    if (
      typeof c.chartType !== 'string' ||
      !(CHART_TYPES as readonly string[]).includes(c.chartType)
    )
      return null;
    if (
      typeof c.valueLabels !== 'string' ||
      !(VALUE_LABELS as readonly string[]).includes(c.valueLabels)
    )
      return null;
    let data: ChartData;
    try {
      data = validateChartData(c.data);
    } catch {
      return null;
    }
    const spec: ChartSpec = {
      ...(typeof c.title === 'string' && c.title ? { title: c.title } : {}),
      data,
      chartType: c.chartType as ChartType,
      chartTypeAuto: c.chartTypeAuto === true,
      valueLabels: c.valueLabels as ValueLabels,
      ...(Array.isArray(c.pageSourceRefs)
        ? {
            pageSourceRefs: (c.pageSourceRefs as unknown[])
              .filter(isRecord)
              .map((r) => ({
                sourceId: String((r as Record<string, unknown>).sourceId ?? ''),
                sourceKind: (r as Record<string, unknown>)
                  .sourceKind as PageSourceRefInput['sourceKind'],
                locator: String((r as Record<string, unknown>).locator ?? ''),
              })),
          }
        : {}),
    };
    let kpiCards: KpiCard[] | undefined;
    if (item.kpiCards !== undefined) {
      if (!Array.isArray(item.kpiCards)) return null;
      kpiCards = [];
      for (const k of item.kpiCards as unknown[]) {
        if (!isRecord(k)) return null;
        if (typeof k.title !== 'string' || !k.title) return null;
        if (typeof k.value !== 'number' || !Number.isFinite(k.value))
          return null;
        if (!isRectInLike(k.rectIn)) return null;
        kpiCards.push({
          title: k.title,
          value: k.value,
          ...(typeof k.unit === 'string' && k.unit ? { unit: k.unit } : {}),
          rectIn: k.rectIn as RectIn,
        });
      }
    }
    out.push({
      pageNo: item.pageNo,
      rectIn: item.rectIn as RectIn,
      chart: spec,
      ...(kpiCards ? { kpiCards } : {}),
    });
  }
  return out;
}

/** 回显用摘要（类型、是否自动选、标签模式、类目与系列名）。 */
export function chartSummary(spec: ChartSpec): {
  chartType: ChartType;
  chartTypeAuto: boolean;
  valueLabels: ValueLabels;
  categories: string[];
  series: string[];
} {
  return {
    chartType: spec.chartType,
    chartTypeAuto: spec.chartTypeAuto,
    valueLabels: spec.valueLabels,
    categories: spec.data.categories,
    series: spec.data.series.map((s) => s.name),
  };
}
