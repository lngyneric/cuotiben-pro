import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { envConfigs } from '@/config';
import { docSectionUrl, loadDocIndex } from '@/modules/ai-assistant/doc-index';
import {
  AI_ASSISTANT_QUERY_MAX_LENGTH,
  parseCourseLink,
  runAssistantQuery,
  type CourseCatalogItem,
} from '@/modules/ai-assistant/service';
import { getConfig } from '@/modules/config/service';
import {
  findPublishedBySlug,
  listPublishedArticles,
} from '@/modules/posts/service';
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr } from '@/lib/resp';

// POST /api/ai-assistant/recommend — 大圆找课流程的网页版 + 文档问答。
//
// 身份：必须 AAD 登录（会话即身份，未登录 401），与大圆“先验证身份再查课”
// 一致；邮箱/工号只用于会话鉴权，不在响应里出现。
// 数据：sqlite post 表，全量已发布课程（slug 以 course- 开头），与大圆
// posts_list pageSize=100 拉全量再匹配的做法一致；文档来自已上传 HTML
// 文件的 section 索引（doc-index.ts，见模块注释）。
// 模型：OpenAI 兼容接口，base_url 与密钥取自管理后台 Settings → OpenAI
// （DB 加密存储，无 env fallback）。生产部署上 base_url 填本机 Magpie
// 网关 http://magpie:3425/v1，模型固定 opencode-go/deepseek-v4.1-flash。
// 意图路由：有 TYPESAFE_API_KEY 时先调 Jev 做意图分类 + 课程/文档候选
// 打分（一次调用）——文档问题走文档链路（LLM 按 section 原文作答，只按
// 原文、不编造）；意图明确与课程学习、文档内容都无关时直接返回查不到
// （不硬推课）。Jev 超时/失败/无 key 时静默回退原有链路，页面不受影响。
// 决策链的细节见 service.ts runAssistantQuery。
// 安全：base_url 未配置时绝不调 LLM（不默认 api.openai.com，避免把网关
// 密钥发向第三方）；LLM 失败时降级为关键词匹配/原文摘录，不向客户端
// 泄露上游错误。
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

    // 文档索引读不到（读库/读盘失败）时按空索引处理，不阻塞课程链路。
    const docSections = await loadDocIndex().catch(() => []);

    const baseUrl = (await getConfig('openai_base_url'))?.trim() || '';
    const apiKey = (await getConfig('openai_api_key'))?.trim() || '';

    const result = await runAssistantQuery({
      query,
      catalog,
      docSections,
      resolveCourse: async (slug) => {
        const post = await findPublishedBySlug(slug);
        if (!post?.content) return null;
        return parseCourseLink(post.content);
      },
      docSectionUrl,
      jevKey: envConfigs.typesafe_api_key?.trim() || '',
      proxyUrl: envConfigs.typesafe_proxy_url?.trim() || undefined,
      baseUrl,
      apiKey,
    });

    return respData(result);
  } catch {
    // 上游/数据库错误不向客户端泄露细节。
    return respErr('推荐服务暂时不可用，请稍后再试', { status: 503 });
  }
}

export const Route = createFileRoute('/api/ai-assistant/recommend')({
  server: { handlers: { POST } },
});
