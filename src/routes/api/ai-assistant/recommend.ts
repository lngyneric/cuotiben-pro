import { createFileRoute } from '@tanstack/react-router';
import { eq } from 'drizzle-orm';

import { getAuth } from '@/core/auth';
import { db } from '@/core/db';
import { envConfigs } from '@/config';
import { user } from '@/config/db/schema';
import { docSectionUrl, loadDocIndex } from '@/modules/ai-assistant/doc-index';
import {
  inferRoleFromDepartment,
  looksLikeKbQuery,
  parseAssistantRole,
  readStatusForCaller,
  searchKbMcp,
  type StatusScope,
} from '@/modules/ai-assistant/mcp';
import {
  AI_ASSISTANT_QUERY_MAX_LENGTH,
  parseCourseLink,
  runAssistantQuery,
  splitKeywordList,
  type CourseCatalogItem,
  type DocCandidate,
} from '@/modules/ai-assistant/service';
import { getConfig } from '@/modules/config/service';
import { recordEvent } from '@/modules/events/service';
import {
  findPublishedBySlug,
  listPublishedArticles,
} from '@/modules/posts/service';
import { hasPermission } from '@/modules/rbac/service';
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr } from '@/lib/resp';

// POST /api/ai-assistant/recommend — 大圆找课流程的网页版 + 文档问答 + MCP。
//
// 身份：必须 AAD 登录（会话即身份，未登录 401），与大圆“先验证身份再查课”
// 一致；邮箱/工号只用于会话鉴权，不在响应里出现。
// 数据：直接读 blog 数据库的表，不走 blog 的 HTTP/MCP 接口——
//   - 课程：sqlite post 表，全量已发布课程（slug 以 course- 开头），与大圆
//     posts_list pageSize=100 拉全量再匹配的做法一致；
//   - 状态：user_status_summary 表，按调用方权限过滤后读（管理员看全部，
//     学员只看自己按工号，导师看自己带的学员按带教负责人姓名；姓名不唯一
//     时导师范围置空，不猜）；
//   - 文档：已上传 HTML 文件的 section 索引（doc-index.ts）＋企业知识库
//     sysmex-kb MCP（像查制度/流程/入职文档的问题才调，token 未配或调用
//     失败时跳过，不阻塞问答）。
// 角色：销售 / 应用 / 客服三档，只影响回答角度（后端维度，助手页暂不显示
// 切换）；请求可带 role，未带时按提问人所在部门推断，默认应用。
// 模型：OpenAI 兼容接口，base_url 与密钥取自管理后台 Settings → OpenAI
// （DB 加密存储，无 env fallback）。生产部署上 base_url 填本机 Magpie
// 网关 http://magpie:3425/v1，模型固定 opencode-go/deepseek-v4.1-flash。
// 意图路由：有 TYPESAFE_API_KEY 时先调 Jev 做意图分类 + 课程/文档候选
// 打分（一次调用）——文档问题走文档链路（LLM 按 section 原文作答，只按
// 原文、不编造）；意图明确与课程学习、文档内容都无关时直接返回查不到
// （不硬推课）。Jev 超时/失败/无 key 时静默回退原有链路，页面不受影响。
// 决策链的细节见 service.ts runAssistantQuery。
// 审计：每次问答记一条 user_event（kind=ai_assistant_query，只记模式/
// 路由/是否命中/课程数，不记原问句）。
// 安全：base_url 未配置时绝不调 LLM（不默认 api.openai.com，避免把网关
// 密钥发向第三方）；LLM 失败时降级为关键词匹配/原文摘录，不向客户端
// 泄露上游错误；kb_mcp_token 只发往配置的 kb_mcp_url，改 URL 须重填
// token（见 config/service.ts 的 ENDPOINT_SECRETS）。
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

    // 身份：wiki 用户行（邮箱 <工号>@sysmex.internal）→ 工号；admin 另判。
    const [me] = await db()
      .select()
      .from(user)
      .where(eq(user.id, session.user.id))
      .limit(1)
      .catch(() => []);
    const email = me?.email ?? session.user.email ?? '';
    const employeeNo = email.includes('@')
      ? email.split('@')[0].toLowerCase()
      : null;
    const isAdmin = await hasPermission(session.user.id, 'admin.*').catch(
      () => false
    );
    const scope: StatusScope = isAdmin
      ? { kind: 'admin' }
      : { kind: 'self', employeeNo, name: me?.name ?? null };
    const statusSummaries = await readStatusForCaller(scope).catch(() => []);
    const role = body?.role
      ? parseAssistantRole(body.role)
      : inferRoleFromDepartment(statusSummaries[0]?.department ?? null);

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
        keywords: splitKeywordList(r.tags),
      }));

    // 文档索引读不到（读库/读盘失败）时按空索引处理，不阻塞课程链路。
    // 像查制度/流程的问题，另调 sysmex-kb MCP 补知识库结果（token 未配或
    // 调用失败时跳过，结果拼成同形的 DocCandidate 进同一条文档链路）。
    // 知识库只对管理员开放：非管理员不调 MCP（搜索本身走 MCP 服务的
    // 登录账号权限，门控管的是谁能触发）。
    let kbSections: DocCandidate[] = [];
    const kbToken = (await getConfig('kb_mcp_token'))?.trim() || '';
    if (kbToken && isAdmin && looksLikeKbQuery(query)) {
      const kbUrl =
        (await getConfig('kb_mcp_url'))?.trim() ||
        'http://100.117.252.66:8000/mcp';
      const hits = await searchKbMcp({
        url: kbUrl,
        token: kbToken,
        query,
      }).catch(() => []);
      kbSections = hits.map((h, i) => ({
        docKey: 'sysmex-kb',
        docTitle: '企业知识库',
        sectionId: `kb-${i}`,
        sectionTitle: h.category
          ? `【${h.category}${h.fileType ? ` · ${h.fileType}` : ''}】${h.title}`
          : h.title,
        text: h.text,
        links: h.url ? [{ text: '原文', href: h.url }] : [],
      }));
    }
    const docSections = [
      ...(await loadDocIndex().catch(() => [])),
      ...kbSections,
    ];

    const baseUrl = (await getConfig('openai_base_url'))?.trim() || '';
    const apiKey = (await getConfig('openai_api_key'))?.trim() || '';

    const result = await runAssistantQuery({
      query,
      catalog,
      docSections,
      role,
      statusSummaries,
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

    // 审计：只记模式/路由/是否命中/课程数，不记原问句。
    recordEvent({
      userId: session.user.id,
      kind: 'ai_assistant_query',
      detail: {
        mode: result.mode,
        routedBy: result.routedBy,
        found: result.found,
        courses: result.courses.length,
      },
    });

    return respData({ ...result, role, status: statusSummaries });
  } catch {
    // 上游/数据库错误不向客户端泄露细节。
    return respErr('推荐服务暂时不可用，请稍后再试', { status: 503 });
  }
}

export const Route = createFileRoute('/api/ai-assistant/recommend')({
  server: { handlers: { POST } },
});
