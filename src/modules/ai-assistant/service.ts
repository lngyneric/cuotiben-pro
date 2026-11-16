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
// 本模块是纯函数，不读数据库、不读配置：目录、base_url、密钥都由 API 路由
// 传入。LLM 不可用（未配置、超时、返回非法）时调用方降级为关键词匹配，
// 页面照常可用。

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

/**
 * 关键词匹配（大圆流程的兜底做法，也是 LLM 未配置时的推荐方式）。
 * 匹配依据按优先级：标题（3 分）→ 分类（2 分）→ 简介（1 分）。
 */
export function keywordRecommend(
  catalog: CourseCatalogItem[],
  query: string
): string[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const scored = catalog
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
  return scored.slice(0, AI_ASSISTANT_MAX_RESULTS).map((r) => r.slug);
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
        max_tokens: 256,
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
