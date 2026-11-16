// AI 学习助手：企微大圆找课流程的网页版。
//
// 对应 wiki 里的《大圆课程助手技能》（slug: dayuan-course-assistant-skill）：
//   1. 身份先行 — 网页版由调用方（API 路由）要求 AAD 登录会话，未登录 401，
//      不在正文里复述邮箱/工号；
//   2. 拉全量再匹配 — 一次读出全部已发布课程（slug 以 course- 开头），按
//      标题 → 分类 → 简介匹配主题，不只靠标题搜索；
//   3. 链接从正文读 — 锁定课程后取单篇全文，从开头的“课程链接”一行读出
//      链接，绝不自己拼；
//   4. 一次推荐 1–2 门，查不到就直说查不到。
//
// 意图路由（Jev）：推荐链路里先调 TypeSafe Jev 做两件事——①意图分类
// （choice：推荐课程 / 了解某门课 / 学习规划 / 其他）；②对关键词粗筛
// 出的候选课做语义相关性打分（noul，每门一题）。Jev 只做判断、不生成：
// 意图明确与课程学习无关且置信度够高时直接返回查不到（不硬推课、不浪费
// 一次 LLM 调用）；打分高的候选收窄后交给 Magpie LLM 做最终挑选；Jev
// 超时、失败、无 key 时一律静默回退到原有链路（LLM 全量目录 → 关键词
// 匹配）。内网直连 api.typesafe.ai 会被地域屏蔽（HTTP 451），须经出口
// 代理（TYPESAFE_PROXY_URL，如 http://172.17.0.1:7897）；Node 22 的
// fetch 不读代理环境变量，所以 Jev 请求走 node:https + 自建 CONNECT
// 代理 agent，不引入新依赖。
//
// 本模块是纯函数，不读数据库、不读配置：目录、base_url、密钥都由 API 路由
// 传入。LLM 不可用（未配置、超时、返回非法）时调用方降级为关键词匹配，
// 页面照常可用。

import * as https from 'node:https';
import * as net from 'node:net';
import { Duplex } from 'node:stream';
import * as tls from 'node:tls';

export interface CourseCatalogItem {
  slug: string;
  title: string;
  description: string;
  categories: string[];
}

export type CourseType = 'video' | 'text';

export interface RecommendedCourse extends CourseCatalogItem {
  type: CourseType;
  link: string;
}

/** 与 ai-shifu PRD 默认一致：经本机 Magpie 网关的 DeepSeek 模型。 */
export const AI_ASSISTANT_MODEL = 'opencode-go/deepseek-v4.1-flash';

export const AI_ASSISTANT_MAX_RESULTS = 2;

/** 用户输入长度上限（字符），与服务端校验一致。 */
export const AI_ASSISTANT_QUERY_MAX_LENGTH = 200;

const COURSE_LINK_RE = /课程链接[：:][*\s]*?(https?:\/\/[^\s<>"')\]]+)/;
const COURSE_TYPE_RE = /类型[：:]\s*(视频课|文本课)/;

/**
 * 从课程正文开头读出课程链接与类型。读不到链接返回 null —— 调用方必须
 * 丢弃这门课，绝不能自己拼链接（大圆红线）。
 */
export function parseCourseLink(content: string): {
  link: string;
  type: CourseType;
} | null {
  const linkMatch = COURSE_LINK_RE.exec(content || '');
  if (!linkMatch) return null;
  const link = linkMatch[1];
  const typeMatch = COURSE_TYPE_RE.exec(content);
  const type: CourseType =
    typeMatch?.[1] === '视频课'
      ? 'video'
      : typeMatch?.[1] === '文本课'
        ? 'text'
        : link.includes('video-player.html')
          ? 'video'
          : 'text';
  return { link, type };
}

function tokenize(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[\s,，。；;、/\\|]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const whole = query.trim().toLowerCase();
  if (whole.length >= 2 && !terms.includes(whole)) terms.push(whole);
  return terms;
}

export interface KeywordScore {
  slug: string;
  score: number;
}

/**
 * 关键词打分（标题 3 分 → 分类 2 分 → 简介 1 分），按分数降序。
 * 只返回分数 > 0 的课。keywordRecommend 与 Jev 候选粗筛共用这一份。
 */
export function keywordScoreList(
  catalog: CourseCatalogItem[],
  query: string
): KeywordScore[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  return catalog
    .map((course) => {
      const title = course.title.toLowerCase();
      const description = course.description.toLowerCase();
      const categories = course.categories.map((c) => c.toLowerCase());
      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 3;
        if (categories.some((c) => c.includes(term))) score += 2;
        if (description.includes(term)) score += 1;
      }
      return { slug: course.slug, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * 关键词匹配（大圆流程的兜底做法，也是 LLM 未配置时的推荐方式）。
 * 匹配依据按优先级：标题（3 分）→ 分类（2 分）→ 简介（1 分）。
 */
export function keywordRecommend(
  catalog: CourseCatalogItem[],
  query: string
): string[] {
  return keywordScoreList(catalog, query)
    .slice(0, AI_ASSISTANT_MAX_RESULTS)
    .map((r) => r.slug);
}

export interface RecommendLLMInput {
  baseUrl: string;
  apiKey: string;
  model?: string;
  query: string;
  catalog: CourseCatalogItem[];
}

/**
 * 调 OpenAI 兼容的 chat completions 接口（本机部署指向 Magpie 网关）
 * 做课程推荐。只要求模型输出 JSON 的 slug 列表，返回前逐个校验 slug
 * 确实在目录里；任何失败（网络、非 200、非法 JSON、非法 slug）都返回
 * null，由调用方降级为关键词匹配。LLM 的文字输出不向客户端回显。
 */
export async function callRecommendLLM({
  baseUrl,
  apiKey,
  model = AI_ASSISTANT_MODEL,
  query,
  catalog,
}: RecommendLLMInput): Promise<string[] | null> {
  const catalogText = catalog
    .map(
      (c) =>
        `${c.slug} | ${c.title} | ${c.categories.join(',')} | ${c.description.slice(0, 120)}`
    )
    .join('\n');
  const systemPrompt = [
    '你是企业大学 wiki 的 AI 学习助手，按以下规则推荐课程：',
    '1. 只从下面给出的课程目录里选，最多 2 门；目录里没有的课绝不编造。',
    '2. 匹配依据按优先级：标题 → 分类 → 简介。',
    '3. 只输出 JSON，不要任何解释文字，格式：{"slugs": ["course-xxx", "..."]}。没有匹配的课时输出 {"slugs": []}。',
    '4. 不要输出思考过程，直接给出 JSON。',
    '课程目录（slug | 标题 | 分类 | 简介）：',
    catalogText,
  ].join('\n');

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        // 模型会先做推理再输出：256 会被推理占满、到 length 截断时正文
        // 仍为空（2026-11-16 实测），1024 才够推理 + JSON 答案。
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
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
  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.slugs)) return null;
  const known = new Set(catalog.map((c) => c.slug));
  const slugs = parsed.slugs.filter(
    (s: unknown): s is string => typeof s === 'string' && known.has(s)
  );
  return slugs.slice(0, AI_ASSISTANT_MAX_RESULTS);
}

// ---------------------------------------------------------------------------
// Jev 意图路由（TypeSafe SystemOne，判断模型：只打分和选择，不生成文本）
// ---------------------------------------------------------------------------

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
/** Jev 首次调用可能冷启动 ~9s，15s 超时可覆盖冷启动；超时即回退。 */
export const JEV_TIMEOUT_MS = 15_000;
/** 交给 Jev 打分的候选数上限：先由关键词粗筛，不一次问全量 55 门。 */
export const JEV_CANDIDATE_LIMIT = 8;
/** noul 相关性阈值（0–1，0.5 为中性）：高于此才进 LLM 短名单。 */
export const JEV_RELEVANCE_THRESHOLD = 0.6;
/** 意图置信度阈值：只有高于此才按“与课程学习无关”直接返回查不到。 */
export const JEV_INTENT_CONFIDENCE_THRESHOLD = 0.7;

export type AssistantIntent =
  | 'recommend'
  | 'course_info'
  | 'study_plan'
  | 'other';

export interface JevCandidate {
  slug: string;
  title: string;
  categories: string[];
  description: string;
}

export interface JevRouting {
  intent: AssistantIntent;
  intentConfidence: number;
  /** 按 noul 降序，每项都是调用方给出的候选之一。 */
  scores: { slug: string; noul: number }[];
}

export interface JevRoutingInput {
  apiKey: string;
  /** 出口代理（如 http://172.17.0.1:7897）；不填则直连。 */
  proxyUrl?: string;
  query: string;
  /** 关键词粗筛出的候选（可为空：为空时只做意图分类）。 */
  candidates: JevCandidate[];
}

/** Jev 传输层：默认走 node:https；测试可注入桩，禁止真实联网。 */
export interface JevTransport {
  postJson: (
    url: string,
    payload: unknown,
    opts: { apiKey: string; proxyUrl?: string; timeoutMs: number }
  ) => Promise<{ status: number; body: string }>;
}

/**
 * 把写出的数据先缓存、等真实 socket 就绪后再转发（agent-base 同款
 * DelayedStream 做法）：https.request 可能在 CONNECT 握手完成前就写
 * 请求头，返回的 Duplex 必须能提前接受写入。
 */
class DelayedSocket extends Duplex {
  private target: net.Socket | null = null;
  private buffered: {
    chunk: Buffer;
    encoding: BufferEncoding;
    cb: (err?: Error | null) => void;
  }[] = [];
  private ended = false;

  _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    cb: (err?: Error | null) => void
  ): void {
    if (this.target) {
      this.target.write(chunk, encoding, cb);
      return;
    }
    this.buffered.push({ chunk: Buffer.from(chunk), encoding, cb });
  }

  _read(): void {
    if (this.target) this.target.resume();
  }

  _final(cb: (err?: Error | null) => void): void {
    this.ended = true;
    if (this.target) this.target.end(cb);
    else cb();
  }

  _destroy(err: Error | null, cb: (err: Error | null) => void): void {
    if (this.target) this.target.destroy();
    cb(err);
  }

  attach(socket: net.Socket): void {
    this.target = socket;
    for (const { chunk, encoding, cb } of this.buffered) {
      socket.write(chunk, encoding, cb);
    }
    this.buffered = [];
    socket.on('data', (c: Buffer) => {
      if (!this.push(c)) socket.pause();
    });
    socket.on('end', () => this.push(null));
    socket.on('error', (e) => this.destroy(e));
    socket.on('close', () => {
      if (!this.destroyed) this.push(null);
    });
    if (this.ended) socket.end();
    socket.resume();
  }
}

/**
 * 最小 HTTPS-via-HTTP-proxy agent：对代理发 CONNECT 建隧道，再在隧道上
 * 做 TLS 握手。只给 Jev 调用用（内网直连 TypeSafe 会被地域屏蔽 451）。
 * Node 22 的 fetch 不读代理环境变量，又不希望为这一个调用引入 undici
 * 依赖（还会拖垮 Cloudflare Worker 构建），所以用 node 内置模块手写。
 */
class HttpsProxyAgent extends https.Agent {
  private readonly proxy: URL;
  private readonly timeoutMs: number;

  constructor(proxyUrl: string, timeoutMs: number) {
    super({ keepAlive: false });
    this.proxy = new URL(proxyUrl);
    this.timeoutMs = timeoutMs;
  }

  override createConnection(
    options: Parameters<https.Agent['createConnection']>[0],
    callback: (err: Error | null, socket?: Duplex) => void
  ): ReturnType<https.Agent['createConnection']> {
    const delayed = new DelayedSocket();
    const targetHost = String((options as { host?: unknown }).host ?? '');
    const targetPort = Number((options as { port?: unknown }).port ?? 443);
    const socket = net.connect({
      host: this.proxy.hostname,
      port: Number(this.proxy.port || 80),
    });
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      delayed.destroy(err);
      callback(err);
    };
    socket.setTimeout(this.timeoutMs, () =>
      fail(new Error('proxy CONNECT timeout'))
    );
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          `Proxy-Connection: close\r\n\r\n`
      );
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        socket.off('data', onData);
        const head = buf.subarray(0, end).toString('ascii');
        const status = Number(head.split(' ')[1]);
        if (status !== 200) {
          fail(
            new Error(`proxy CONNECT failed: ${head.split('\r\n')[0] ?? ''}`)
          );
          return;
        }
        const rest = buf.subarray(end + 4);
        const tlsSocket = tls.connect({ socket, servername: targetHost });
        tlsSocket.once('error', fail);
        tlsSocket.once('secureConnect', () => {
          // 握手完成：原始 socket 的 CONNECT 超时不再需要，整体超时由
          // https.request 的 AbortSignal 负责。
          socket.setTimeout(0);
          if (rest.length > 0) tlsSocket.unshift(rest);
          if (settled) return;
          settled = true;
          delayed.attach(tlsSocket as unknown as net.Socket);
          callback(null, delayed as unknown as Duplex);
        });
      };
      socket.on('data', onData);
    });
    return delayed as unknown as ReturnType<https.Agent['createConnection']>;
  }
}

/** 经 node:https 发一次 JSON POST（带 key、超时、可选代理）。导出仅供运维排障与测试用。 */
export async function postJevJson(
  url: string,
  payload: unknown,
  opts: { apiKey: string; proxyUrl?: string; timeoutMs: number }
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  const body = JSON.stringify(payload);
  const agent = opts.proxyUrl
    ? new HttpsProxyAgent(opts.proxyUrl, opts.timeoutMs)
    : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
        agent,
        signal: AbortSignal.timeout(opts.timeoutMs),
      },
      (resp) => {
        const chunks: Buffer[] = [];
        resp.on('data', (c: Buffer | string) =>
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
        );
        resp.on('end', () =>
          resolve({
            status: resp.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          })
        );
        resp.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const defaultJevTransport: JevTransport = { postJson: postJevJson };

/**
 * 一次 Jev 调用并行做意图分类 + 候选相关性打分。无 key 时不发请求直接
 * 返回 null；任何失败（网络、非 200、非法 JSON、非法意图）都返回 null，
 * 由调用方静默回退到原有链路。绝不抛错、绝不把 key 写进日志。
 */
export async function callJevRouting(
  { apiKey, proxyUrl, query, candidates }: JevRoutingInput,
  transport: JevTransport = defaultJevTransport
): Promise<JevRouting | null> {
  if (!apiKey) return null;
  const questions: Record<string, unknown> = {
    intent: {
      type: 'choice',
      instructions: '用户这句话想让我做什么？只选一个最贴切的。',
      criteria: {
        recommend:
          '用户想让我推荐适合他学的课程：想学某个主题或技能、不知道学什么、让我推荐几门课。',
        course_info:
          '用户想了解某一门具体课程的内容、讲师、时长，或者怎么上这门课。',
        study_plan:
          '用户想做学习规划或学习路径：按阶段安排先学什么、后学什么，或为某个目标制定学习计划。',
        other:
          '用户问的不是课程学习的事（例如请假、报销、系统操作、闲聊打招呼），或无法判断与课程学习有关。',
      },
    },
  };
  for (const [i, c] of candidates.entries()) {
    questions[`rel_${i}`] = {
      type: 'noul',
      instructions:
        `《${c.title}》（分类：${c.categories.join('、') || '未分类'}；` +
        `简介：${c.description.slice(0, 80)}）是否与用户想学的内容相关？`,
    };
  }
  const doc = candidates
    .map(
      (c, i) =>
        `${i + 1}. ${c.slug} | ${c.title} | ${c.categories.join(',')} | ${c.description.slice(0, 120)}`
    )
    .join('\n')
    .slice(0, 2000);

  let res: { status: number; body: string };
  try {
    res = await transport.postJson(
      JEV_ENDPOINT,
      {
        state: { message: query, doc },
        model: JEV_MODEL,
        questions,
      },
      { apiKey, proxyUrl, timeoutMs: JEV_TIMEOUT_MS }
    );
  } catch {
    return null;
  }
  if (res.status !== 200) return null;
  let data: any;
  try {
    data = JSON.parse(res.body);
  } catch {
    return null;
  }
  const answers = data?.answers ?? {};
  const intentAns = answers.intent ?? {};
  const intent = typeof intentAns.choice === 'string' ? intentAns.choice : '';
  const validIntents: AssistantIntent[] = [
    'recommend',
    'course_info',
    'study_plan',
    'other',
  ];
  if (!validIntents.includes(intent as AssistantIntent)) return null;
  const confidence =
    typeof intentAns.confidence === 'number' ? intentAns.confidence : 0;
  const scores = candidates
    .map((c, i) => {
      const n = answers[`rel_${i}`]?.noul;
      return {
        slug: c.slug,
        noul:
          typeof n === 'number' && Number.isFinite(n)
            ? Math.min(1, Math.max(0, n))
            : 0,
      };
    })
    .sort((a, b) => b.noul - a.noul);
  return {
    intent: intent as AssistantIntent,
    intentConfidence: confidence,
    scores,
  };
}

/**
 * Jev 短名单：相关性打分高于阈值的候选，最多 AI_ASSISTANT_MAX_RESULTS
 * 门。为空时调用方用全量目录调 LLM（原有行为）。
 */
export function jevShortlist(routing: JevRouting | null): string[] {
  if (!routing) return [];
  return routing.scores
    .filter((s) => s.noul >= JEV_RELEVANCE_THRESHOLD)
    .slice(0, AI_ASSISTANT_MAX_RESULTS)
    .map((s) => s.slug);
}

/** 意图明确与课程学习无关（且置信度够高）时直接返回查不到。 */
export function isOffTopicIntent(routing: JevRouting | null): boolean {
  return (
    !!routing &&
    routing.intent === 'other' &&
    routing.intentConfidence >= JEV_INTENT_CONFIDENCE_THRESHOLD
  );
}
