// 轻量路：outline 拆分走 Magpie LLM + Jev 分组判定。
//
// 模型全程 deepseek-v4.1-flash（AI_ASSISTANT_MODEL），不引入 fast 模型，
// 不碰 Presenton 的模型配置。LLM 只做分组（标题 + 段落归属 + 版式建议），
// 要点正文仍由确定性代码从来源原文取，不编内容；分组校验失败 → 确定性
// 拆分。Jev 只做判定（与意图的相关性 + 页内一致性），不通过自动重分一次，
// 再不通过把草稿标疑点返回，由用户在确认时定夺；Jev 不可用时判定跳过、
// 不阻塞。判定结论不抛错、不记 key、不记原文。
//
// 跨模块 import 的例外（与 sources.ts 的 attachments/blog-html 同款）：
// Jev 通用调用、Magpie 模型常量与配置读取复用 AI 学习助手链路，不另造一套。

import { envConfigs } from '@/config';
import {
  AI_ASSISTANT_MODEL,
  callJevQuestions,
  JEV_RELEVANCE_THRESHOLD,
  type JevTransport,
} from '@/modules/ai-assistant/service';
import { getConfig } from '@/modules/config/service';

import type { OutlinePage } from './sources';

export type OutlineSplitMode = 'llm' | 'deterministic';
export type OutlineVerdictStatus = 'pass' | 'needs_review' | 'skipped';

export interface OutlinePageScore {
  pageNo: number;
  /** 该页与用户意图的相关性（Jev noul，0–1）。 */
  relevance: number;
  /** 该页要点围绕同一主题的程度（Jev noul，0–1）。 */
  coherence: number;
  failed: boolean;
  reasons: string[];
}

export interface OutlineVerdict {
  status: OutlineVerdictStatus;
  splitMode: OutlineSplitMode;
  /** 判定次数：重分后复判为 2。 */
  attempts: number;
  scores: OutlinePageScore[];
  /** 疑点页说明（needs_review 时非空；skipped 时写跳过原因）。 */
  warnings: string[];
  judgedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验并解析 outline 判定结论（JSON 字符串或已解析对象）；结构不对返回 null。 */
export function parseOutlineVerdict(value: unknown): OutlineVerdict | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (!value) return null;
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed)) return null;
  if (
    parsed.status !== 'pass' &&
    parsed.status !== 'needs_review' &&
    parsed.status !== 'skipped'
  )
    return null;
  if (parsed.splitMode !== 'llm' && parsed.splitMode !== 'deterministic')
    return null;
  if (
    typeof parsed.attempts !== 'number' ||
    !Number.isInteger(parsed.attempts) ||
    parsed.attempts < 1
  )
    return null;
  if (typeof parsed.judgedAt !== 'number' || parsed.judgedAt <= 0) return null;
  if (!Array.isArray(parsed.scores)) return null;
  const scores: OutlinePageScore[] = [];
  for (const s of parsed.scores as unknown[]) {
    if (!isRecord(s)) return null;
    if (
      typeof s.pageNo !== 'number' ||
      !Number.isInteger(s.pageNo) ||
      s.pageNo < 1
    )
      return null;
    for (const k of ['relevance', 'coherence'] as const) {
      if (typeof s[k] !== 'number' || s[k] < 0 || s[k] > 1) return null;
    }
    if (typeof s.failed !== 'boolean') return null;
    if (
      !Array.isArray(s.reasons) ||
      s.reasons.some((r) => typeof r !== 'string')
    )
      return null;
    scores.push({
      pageNo: s.pageNo,
      relevance: s.relevance as number,
      coherence: s.coherence as number,
      failed: s.failed,
      reasons: [...(s.reasons as string[])],
    });
  }
  if (
    !Array.isArray(parsed.warnings) ||
    parsed.warnings.some((w) => typeof w !== 'string')
  )
    return null;
  return {
    status: parsed.status,
    splitMode: parsed.splitMode,
    attempts: parsed.attempts,
    scores,
    warnings: [...(parsed.warnings as string[])],
    judgedAt: parsed.judgedAt,
  };
}

/** Magpie 配置（config 表 openai_base_url/openai_api_key，与 AI 学习助手同款）：缺任何一项即不调 LLM。 */
export async function resolveOutlineLlmConfig(): Promise<{
  baseUrl: string;
  apiKey: string;
} | null> {
  const baseUrl = ((await getConfig('openai_base_url')) || '').trim();
  const apiKey = ((await getConfig('openai_api_key')) || '').trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

/** Jev 配置（服务器环境变量，与 AI 学习助手推荐链路同款）。 */
export function resolveOutlineJevConfig(): {
  apiKey: string;
  proxyUrl?: string;
} {
  return {
    apiKey: envConfigs.typesafe_api_key?.trim() || '',
    proxyUrl: envConfigs.typesafe_proxy_url?.trim() || undefined,
  };
}

// ─── Magpie JSON 调用（与 callRecommendLLM 同款形态）──────────────────────

export interface MagpieJsonInput {
  baseUrl: string;
  apiKey: string;
  model?: string;
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * 调 OpenAI 兼容的 chat completions 接口（本机部署指向 Magpie 网关），
 * 只要模型输出的 JSON。任何失败（网络、非 200、非法 JSON、空输出）都
 * 返回 null，由调用方降级。LLM 的文字输出不向客户端回显、不记日志。
 */
export async function callMagpieJson({
  baseUrl,
  apiKey,
  model = AI_ASSISTANT_MODEL,
  system,
  user,
  maxTokens = 4096,
  timeoutMs = 60_000,
  fetchImpl = fetch,
}: MagpieJsonInput): Promise<unknown | null> {
  let resp: Response;
  try {
    resp = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  let data: any;
  try {
    data = await resp.json();
  } catch {
    return null;
  }
  const content = String(data?.choices?.[0]?.message?.content ?? '').trim();
  if (!content) return null;
  const jsonText = content
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

// ─── LLM 分组（只定标题 + 段落归属 + 版式建议）────────────────────────────

export interface LlmSection {
  heading: string;
  body: string;
}

export interface LlmPageGrouping {
  title: string;
  sectionIndexes: number[];
  layout: string;
  reason: string;
}

/** LLM 分组输入上限：超了走确定性拆分（不截断丢段）。 */
export const LLM_SPLIT_MAX_INPUT_CHARS = 12000;
/** LLM 分组超时：与 AI 学习助手推荐 LLM 同款 60 秒。 */
export const LLM_SPLIT_TIMEOUT_MS = 60_000;

const LLM_SPLIT_SYSTEM = [
  '你是企业大学 wiki 的 PPT 页面划分助手。只做分组，不写正文、不编内容。',
  '输入是按编号分段的来源文本（每段一个主题或一节），以及用户的做稿意图。',
  '任务：把段落按主题分到各页，每页只讲一个主题。',
  '规则：',
  '1. 每个编号段落恰好进一页，不丢、不重、不拆段（一段不拆到两页）。',
  '2. 同一主题的段落并进一页；不同主题另起一页；主题稍有不同就分开。',
  '3. 每页标题不超过 20 字，直接取自该页段落的主题，不编新概念。',
  '4. 每页版式从 A–H 里选一个最贴切的并给一句话理由：A 数据条+四卡；B 左文右图；C 二二网格；D 三栏；E 上图下文；F 横向步骤时间线；G 左1右2分列；H 左右平分·左列上下。',
  '5. 只输出 JSON，不要任何解释：{"pages":[{"title":"...","sections":[0,1],"layout":"B","reason":"..."}]}。',
].join('\n');

/**
 * 调 Magpie（deepseek-v4.1-flash）把上传文本的段落按主题分组。返回的
 * 只是分组方案（标题 + 段落编号 + 版式建议），要点正文仍由调用方从
 * 来源原文取。任何失败（无配置、超时、非法 JSON、分组校验不通过）都
 * 返回 null，由调用方回退到确定性拆分。
 */
export async function splitUploadTextByLlm(input: {
  baseUrl: string;
  apiKey: string;
  model?: string;
  intent: string;
  sections: LlmSection[];
  /** 重分时为 true：拆得更细，宁可多页、不要把两个主题并进一页。 */
  fine?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<LlmPageGrouping[] | null> {
  if (input.sections.length === 0) return null;
  const numbered = input.sections.map((s, i) => {
    const head = s.heading ? `【${s.heading}】` : '';
    return `${i}. ${head}${s.body}`.slice(0, 1500);
  });
  const text = numbered.join('\n---\n');
  if (text.length > LLM_SPLIT_MAX_INPUT_CHARS) return null;
  const system = input.fine
    ? `${LLM_SPLIT_SYSTEM}\n重分要求：拆得更细，主题稍有不同就另起一页，宁可多页、不要把两个主题并进一页。`
    : LLM_SPLIT_SYSTEM;
  const parsed = await callMagpieJson({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    model: input.model,
    system,
    user: `意图：${input.intent.slice(0, 500)}\n\n来源段落（编号）：\n${text}`,
    timeoutMs: LLM_SPLIT_TIMEOUT_MS,
    fetchImpl: input.fetchImpl,
  });
  if (!isRecord(parsed)) return null;
  if (!Array.isArray(parsed.pages)) return null;
  const pages = parsed.pages as unknown[];
  if (pages.length < 1 || pages.length > 50) return null;
  const seen = new Set<number>();
  const out: LlmPageGrouping[] = [];
  for (const p of pages) {
    if (!isRecord(p)) return null;
    if (typeof p.title !== 'string' || !p.title.trim()) return null;
    if (!Array.isArray(p.sections) || p.sections.length === 0) return null;
    const indexes: number[] = [];
    for (const idx of p.sections as unknown[]) {
      if (
        typeof idx !== 'number' ||
        !Number.isInteger(idx) ||
        idx < 0 ||
        idx >= input.sections.length ||
        seen.has(idx)
      )
        return null;
      seen.add(idx);
      indexes.push(idx);
    }
    out.push({
      title: p.title.trim().slice(0, 60),
      sectionIndexes: indexes,
      layout: typeof p.layout === 'string' ? p.layout.trim() : '',
      reason: typeof p.reason === 'string' ? p.reason.trim().slice(0, 200) : '',
    });
  }
  // 覆盖必须完整：每个段落恰好进一页，不丢段。
  if (seen.size !== input.sections.length) return null;
  return out;
}

// ─── Jev 分组判定 ───────────────────────────────────────────────────────────

/** 每次 Jev 调用最多判 8 页（与 AI 学习助手候选上限同量级）。 */
export const OUTLINE_JUDGE_CHUNK_PAGES = 8;

function clampNoul(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n)
    ? Math.min(1, Math.max(0, n))
    : 0;
}

/**
 * 调 Jev 逐页打分：与意图的相关性（rel）+ 页内一致性（coh），阈值沿用
 * JEV_RELEVANCE_THRESHOLD（0.6）。任一分低于阈值即该页不通过。无 key
 * 或任何一次调用失败返回 null（调用方记判定跳过、不阻塞）。
 */
export async function judgeOutlineGrouping(input: {
  apiKey: string;
  proxyUrl?: string;
  intent: string;
  pages: Array<Pick<OutlinePage, 'pageNo' | 'title' | 'points'>>;
  jevTransport?: JevTransport;
}): Promise<{ scores: OutlinePageScore[] } | null> {
  if (!input.apiKey || input.pages.length === 0) return null;
  const intent = input.intent.slice(0, 500);
  const allScores: OutlinePageScore[] = [];
  for (
    let start = 0;
    start < input.pages.length;
    start += OUTLINE_JUDGE_CHUNK_PAGES
  ) {
    const chunk = input.pages.slice(start, start + OUTLINE_JUDGE_CHUNK_PAGES);
    const questions: Record<string, unknown> = {};
    for (const [i, p] of chunk.entries()) {
      const pointsText = p.points.join('；').slice(0, 200);
      questions[`rel_${i}`] = {
        type: 'noul',
        instructions:
          `「${p.title}」这一页（要点：${pointsText}）` +
          `与用户想做的 PPT 主题「${intent.slice(0, 200)}」相关吗？`,
      };
      questions[`coh_${i}`] = {
        type: 'noul',
        instructions:
          `「${p.title}」这一页的要点是否都围绕同一主题、` +
          `放在同一页是否合适？要点：${pointsText}`,
      };
    }
    const doc = chunk.map((p) => `${p.pageNo}. ${p.title}`).join('\n');
    const answers = await callJevQuestions(
      { apiKey: input.apiKey, proxyUrl: input.proxyUrl, query: intent, doc, questions },
      input.jevTransport
    );
    if (!answers) return null;
    for (const [i, p] of chunk.entries()) {
      const rel = clampNoul(answers[`rel_${i}`]?.noul);
      const coh = clampNoul(answers[`coh_${i}`]?.noul);
      const reasons: string[] = [];
      if (rel < JEV_RELEVANCE_THRESHOLD)
        reasons.push(`与主题相关性低（${rel.toFixed(2)}）`);
      if (coh < JEV_RELEVANCE_THRESHOLD)
        reasons.push(`要点主题混杂（${coh.toFixed(2)}）`);
      allScores.push({
        pageNo: p.pageNo,
        relevance: rel,
        coherence: coh,
        failed: reasons.length > 0,
        reasons,
      });
    }
  }
  return { scores: allScores };
}
