import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { envConfigs } from '@/config';
import {
  AI_ASSISTANT_MODEL,
  AI_ASSISTANT_QUERY_MAX_LENGTH,
  callJevRouting,
  callRecommendLLM,
  isOffTopicIntent,
  JEV_CANDIDATE_LIMIT,
  jevShortlist,
  keywordRecommend,
  keywordScoreList,
  parseCourseLink,
  type CourseCatalogItem,
  type JevRouting,
  type RecommendedCourse,
} from '@/modules/ai-assistant/service';
import { getConfig } from '@/modules/config/service';
import {
  findPublishedBySlug,
  listPublishedArticles,
} from '@/modules/posts/service';
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr } from '@/lib/resp';

// POST /api/ai-assistant/recommend — 大圆找课流程的网页版。
//
// 身份：必须 AAD 登录（会话即身份，未登录 401），与大圆“先验证身份再查课”
// 一致；邮箱/工号只用于会话鉴权，不在响应里出现。
// 数据：sqlite post 表，全量已发布课程（slug 以 course- 开头），与大圆
// posts_list pageSize=100 拉全量再匹配的做法一致。
// 模型：OpenAI 兼容接口，base_url 与密钥取自管理后台 Settings → OpenAI
// （DB 加密存储，无 env fallback）。生产部署上 base_url 填本机 Magpie
// 网关 http://magpie:3425/v1，模型固定 opencode-go/deepseek-v4.1-flash。
// 意图路由：有 TYPESAFE_API_KEY 时先调 Jev 做意图分类 + 候选打分——意图
// 明确与课程学习无关时直接返回查不到（不硬推课）；打分高的候选收窄后
// 再调 LLM 挑选。Jev 超时/失败/无 key 时静默回退原有链路，页面不受影响。
// 安全：base_url 未配置时绝不调 LLM（不默认 api.openai.com，避免把网关
// 密钥发向第三方）；LLM 失败时降级为关键词匹配，不向客户端泄露上游错误。
async function POST({ request }: { request: Request }) {
  // 未登录的洪水先在 IP 层挡一道（与 /api/events 同款 200ms 间隔）。
  const ipLimited = enforceMinIntervalRateLimit(request, {
    intervalMs: 200,
    keyPrefix: 'ai-assistant',
  });
  if (ipLimited) return ipLimited;

  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin)
    return respErr('Same-origin request required', { status: 403 });

  try {
    const session = await getAuth().api.getSession({
      headers: request.headers,
    });
    if (!session?.user) return respErr('Unauthorized', { status: 401 });

    // 每人每 10 秒一次：LLM 调用贵，防刷。
    const limited = enforceMinIntervalRateLimit(request, {
      intervalMs: 10_000,
      keyPrefix: 'ai-assistant',
      extraKey: session.user.id,
    });
    if (limited) return limited;

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return respErr('Invalid request', { status: 400 });
    }
    const query = String(body?.query ?? '').trim();
    if (!query || query.length > AI_ASSISTANT_QUERY_MAX_LENGTH)
      return respErr('请输入 200 字以内想学的内容', { status: 400 });

    const rows = await listPublishedArticles({ limit: 100 });
    const catalog: CourseCatalogItem[] = rows
      .filter((r) => r.slug.startsWith('course-'))
      .map((r) => ({
        slug: r.slug,
        title: r.title || r.slug,
        description: r.description || '',
        categories:
          r.categories
            ?.split(',')
            .map((c) => c.trim())
            .filter(Boolean) ?? [],
      }));

    // Jev 意图路由（可选）：无 key 时跳过，超时/失败时返回 null，本段
    // 之外的流程与原来完全一致。日志只记意图与数量，不记用户原问句。
    const jevKey = envConfigs.typesafe_api_key?.trim() || '';
    let jev: JevRouting | null = null;
    if (jevKey) {
      const bySlug = new Map(catalog.map((c) => [c.slug, c]));
      const candidates: CourseCatalogItem[] = [];
      for (const s of keywordScoreList(catalog, query).slice(
        0,
        JEV_CANDIDATE_LIMIT
      )) {
        const c = bySlug.get(s.slug);
        if (c) candidates.push(c);
      }
      jev = await callJevRouting({
        apiKey: jevKey,
        proxyUrl: envConfigs.typesafe_proxy_url?.trim() || undefined,
        query,
        candidates,
      });
      if (jev) {
        console.info(
          `[ai-assistant] jev intent=${jev.intent} conf=${jev.intentConfidence.toFixed(2)} candidates=${candidates.length} shortlist=${jevShortlist(jev).length}`
        );
      } else {
        console.info(
          '[ai-assistant] jev unavailable, falling back to LLM/keyword'
        );
      }
    }

    // 意图明确与课程学习无关：直接返回查不到，不硬推课、不浪费 LLM 调用。
    if (jev && isOffTopicIntent(jev)) {
      return respData({
        mode: 'keyword',
        found: false,
        courses: [],
        routedBy: 'jev',
      });
    }

    let slugs: string[] = [];
    let mode: 'ai' | 'keyword' = 'keyword';
    let routedBy: 'jev' | 'llm' | 'keyword' = 'keyword';
    const baseUrl = (await getConfig('openai_base_url'))?.trim() || '';
    const apiKey = (await getConfig('openai_api_key'))?.trim() || '';
    if (baseUrl && apiKey) {
      // Jev 短名单非空时 LLM 只在短名单里挑（语义已由 Jev 把过关）；
      // 为空时用全量目录，与原来一致。
      const shortlist = jev ? jevShortlist(jev) : [];
      const llmCatalog =
        shortlist.length > 0
          ? catalog.filter((c) => shortlist.includes(c.slug))
          : catalog;
      const llmSlugs = await callRecommendLLM({
        baseUrl,
        apiKey,
        model: AI_ASSISTANT_MODEL,
        query,
        catalog: llmCatalog,
      });
      if (llmSlugs && llmSlugs.length > 0) {
        slugs = llmSlugs;
        mode = 'ai';
        routedBy = jev ? 'jev' : 'llm';
      }
    }
    if (slugs.length === 0) {
      slugs = keywordRecommend(catalog, query);
      mode = 'keyword';
      routedBy = 'keyword';
    }

    const courses: RecommendedCourse[] = [];
    for (const slug of slugs) {
      const post = await findPublishedBySlug(slug);
      if (!post?.content) continue;
      const parsed = parseCourseLink(post.content);
      if (!parsed) continue; // 正文里读不到链接的课不上架，绝不拼链接
      const item = catalog.find((c) => c.slug === slug);
      if (!item) continue;
      courses.push({ ...item, type: parsed.type, link: parsed.link });
    }

    return respData({
      mode,
      found: courses.length > 0,
      courses,
      routedBy,
    });
  } catch {
    // 上游/数据库错误不向客户端泄露细节。
    return respErr('推荐服务暂时不可用，请稍后再试', { status: 503 });
  }
}

export const Route = createFileRoute('/api/ai-assistant/recommend')({
  server: { handlers: { POST } },
});
