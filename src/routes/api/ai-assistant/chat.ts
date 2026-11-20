import { createFileRoute } from '@tanstack/react-router';
import { executeAdmin, findOperation } from '@/server/admin/execute';
import type { AdminActor } from '@/server/admin/types';
import { and, eq } from 'drizzle-orm';

import { getAuth } from '@/core/auth';
import { db } from '@/core/db';
import { user } from '@/config/db/schema';
import {
  AttachmentError,
  MAX_TOTAL_TEXT_CHARS,
  processAttachments,
  type AttachmentInput,
} from '@/modules/ai-assistant/attachments';
import {
  CHAT_MAX_HISTORY_TURNS,
  runAssistantChat,
  type ChatDocHit,
  type ChatHistoryItem,
  type ChatTools,
} from '@/modules/ai-assistant/chat';
import { docSectionUrl, loadDocIndex } from '@/modules/ai-assistant/doc-index';
import {
  inferRoleFromDepartment,
  parseAssistantRole,
  readStatusForCaller,
  searchKbMcp,
  type StatusScope,
} from '@/modules/ai-assistant/mcp';
import {
  AI_ASSISTANT_QUERY_MAX_LENGTH,
  DOC_KEYWORD_MIN_SCORE,
  docKeywordScoreList,
  keywordScoreList,
  parseCourseLink,
  splitKeywordList,
  type CourseCatalogItem,
  type RecommendedCourse,
} from '@/modules/ai-assistant/service';
import { getConfig } from '@/modules/config/service';
import { recordEvent } from '@/modules/events/service';
import {
  findPublishedBySlug,
  listPublishedArticles,
} from '@/modules/posts/service';
import { getUserPermissionCodes, hasPermission } from '@/modules/rbac/service';
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr } from '@/lib/resp';

// POST /api/ai-assistant/chat — 对话式助手（大圆式自由对话）。
//
// 与 /recommend（固定推荐流程）不同：这里接受多轮 history，服务端跑
// LLM 工具循环——LLM 决定何时查课程、文档、知识库、带教状态，最后用
// 中文自然回答；问候闲聊不再回“查不到”。
//
// 工具接入走系统 agent：课程/分类数据经 executeAdmin + 只读 agent
// 「AI 学习助手」（course-advisor 同款 3 项只读权限），与大圆走 MCP
// 是同一套操作注册表、同一套权限过滤，调用记 admin_execution 审计。
// agent 未建或调用失败时，课程读取兜底走公开已发布列表（口径一致，
// 只读已发布），助手不因此整体不可用。状态、文档、知识库是助手内部
// 工具（无对应注册表操作），口径与 recommend 一致：状态按调用方权限
// 过滤，知识库只对管理员开放。
// 鉴权、限流、审计与 recommend 一致；链接只从课程正文读，不编造。

/** 助手 agent 的服务账号名（type='api'，挂 course-advisor 角色）。 */
const ASSISTANT_AGENT_NAME = 'AI 学习助手';

async function resolveAssistantAgent(): Promise<AdminActor | null> {
  const [agent] = await db()
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.type, 'api'), eq(user.name, ASSISTANT_AGENT_NAME)))
    .limit(1)
    .catch(() => []);
  if (!agent) return null;
  const permissions = await getUserPermissionCodes(agent.id).catch(() => []);
  return { userId: agent.id, permissions };
}

/** 经系统 agent 调一个注册表操作，返回解析后的 body（失败返回 null）。 */
async function callAdminOp(
  name: string,
  input: Record<string, unknown>,
  actor: AdminActor
): Promise<any | null> {
  try {
    const op = findOperation(name);
    const res = await executeAdmin(op, input, actor);
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

function toCatalogItem(row: any): CourseCatalogItem | null {
  const slug = String(row?.slug ?? '');
  if (!slug.startsWith('course-')) return null;
  return {
    slug,
    title: String(row?.title ?? slug),
    description: String(row?.description ?? ''),
    categories:
      String(row?.categories ?? '')
        .split(',')
        .map((c: string) => c.trim())
        .filter(Boolean) ?? [],
    keywords: splitKeywordList(row?.tags),
  };
}

async function POST({ request }: { request: Request }) {
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

    // 对话是连续发送的：每人限流放宽到 2 秒（旧推荐接口是 10 秒）。
    // 页面在等回答时已禁用发送按钮，这道限流只防误触连发与刷接口。
    const limited = enforceMinIntervalRateLimit(request, {
      intervalMs: 2_000,
      keyPrefix: 'ai-assistant-chat',
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
      return respErr('请输入 200 字以内想聊的内容', { status: 400 });
    const history: ChatHistoryItem[] = Array.isArray(body?.history)
      ? body.history
          .filter(
            (h: any) =>
              h &&
              (h.role === 'user' || h.role === 'assistant') &&
              typeof h.content === 'string'
          )
          .slice(-CHAT_MAX_HISTORY_TURNS * 2)
          .map((h: any) => ({ role: h.role, content: h.content.slice(0, 500) }))
      : [];

    // 附件：新上传的在内存里抽取文本（用完即弃，不落盘、不记日志），
    // 抽取结果替换旧的参考资料；没有新附件时把旧的原样带过（截断到上限）。
    // 图片只直通本轮，不进参考资料文本。
    const newAttachments: AttachmentInput[] = Array.isArray(body?.attachments)
      ? body.attachments.map((a: any) => ({
          name: String(a?.name ?? ''),
          mime: String(a?.mime ?? ''),
          base64: String(a?.base64 ?? ''),
        }))
      : [];
    let attachmentContext = String(body?.attachmentContext ?? '').slice(
      0,
      MAX_TOTAL_TEXT_CHARS
    );
    let attachmentImages: { mime: string; base64: string }[] = [];
    if (newAttachments.length > 0) {
      try {
        const processed = await processAttachments(newAttachments);
        attachmentContext = processed.context;
        attachmentImages = processed.images;
      } catch (e) {
        if (e instanceof AttachmentError) {
          return respErr(e.message, { status: e.status });
        }
        return respErr('附件处理失败，请换一份文件再试', { status: 400 });
      }
    }

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

    // 系统 agent（只读）：课程/分类工具经它走注册表。
    const agentActor = await resolveAssistantAgent().catch(() => null);

    // 课程目录：优先经 agent 的 posts_list（已发布，拉全量再匹配，与大圆
    // posts_list pageSize=100 的做法一致）；agent 不可用时兜底公开列表。
    let catalog: CourseCatalogItem[] = [];
    const catalogBySlug = new Map<
      string,
      CourseCatalogItem & { id?: string }
    >();
    if (agentActor) {
      const listed = await callAdminOp(
        'posts_list',
        { status: 'published', pageSize: 100 },
        agentActor
      );
      const items: any[] = listed?.code === 0 ? (listed.data?.items ?? []) : [];
      for (const row of items) {
        const item = toCatalogItem(row);
        if (!item) continue;
        catalog.push(item);
        catalogBySlug.set(item.slug, {
          ...item,
          id: String(row.id ?? '') || undefined,
        });
      }
    }
    if (catalog.length === 0) {
      console.warn(
        '[ai-assistant] agent catalog empty, falling back to public list'
      );
      const rows = await listPublishedArticles({ limit: 100 });
      for (const row of rows) {
        const item = toCatalogItem(row);
        if (!item) continue;
        catalog.push(item);
        catalogBySlug.set(item.slug, item);
      }
    }

    // 课程详情解析（最终卡片用）：优先经 agent 的 posts_list{id} 读正文，
    // 失败时兜底公开已发布读取；读不到链接返回 null，课不上架。
    const resolveCourse = async (
      slug: string
    ): Promise<RecommendedCourse | null> => {
      const item = catalogBySlug.get(slug);
      if (!item) return null;
      let content: string | null = null;
      let title = item.title;
      let description = item.description;
      if (agentActor && item.id) {
        const one = await callAdminOp(
          'posts_list',
          { id: item.id },
          agentActor
        );
        if (one?.code === 0 && one?.data) {
          content =
            typeof one.data.content === 'string' ? one.data.content : null;
          if (typeof one.data.title === 'string') title = one.data.title;
          if (typeof one.data.description === 'string')
            description = one.data.description;
        }
      }
      if (!content) {
        const post = await findPublishedBySlug(slug).catch(() => null);
        if (!post?.content) return null;
        content = post.content;
        title = post.title || title;
        description = post.description || description;
      }
      const parsed = parseCourseLink(content);
      if (!parsed) return null;
      return {
        ...item,
        title,
        description,
        type: parsed.type,
        link: parsed.link,
      };
    };

    const docSections = await loadDocIndex().catch(() => []);

    // 知识库：只对管理员开放，token 未配时工具不提供给 LLM。
    const kbToken = (await getConfig('kb_mcp_token'))?.trim() || '';
    const kbUrl =
      (await getConfig('kb_mcp_url'))?.trim() ||
      'http://100.117.252.66:8000/mcp';
    const kbEnabled = Boolean(kbToken && isAdmin);

    const tools: ChatTools = {
      searchCourses: async ({ keywords }) => {
        if (!agentActor && catalog.length === 0)
          return { error: '课程查询暂不可用' };
        const scored = keywordScoreList(catalog, keywords).slice(0, 5);
        const briefs = scored
          .map((s) => catalogBySlug.get(s.slug))
          .filter((c): c is CourseCatalogItem & { id?: string } => !!c)
          .map((c) => ({
            id: c.id ?? '',
            slug: c.slug,
            title: c.title,
            categories: c.categories,
            keywords: c.keywords ?? [],
            description: c.description.slice(0, 120),
          }));
        return briefs;
      },
      getCourse: async ({ slug }) => {
        const c = await resolveCourse(slug);
        if (!c) return { error: '这门课没有课程链接或不存在' };
        return c;
      },
      listCategories: async () => {
        if (!agentActor) return { error: '分类查询暂不可用' };
        const listed = await callAdminOp(
          'categories_list',
          { all: true },
          agentActor
        );
        const items: any[] =
          listed?.code === 0
            ? Array.isArray(listed.data)
              ? listed.data
              : (listed.data?.items ?? [])
            : [];
        return items
          .map((c) => ({
            slug: String(c?.slug ?? ''),
            title: String(c?.title ?? c?.slug ?? ''),
          }))
          .filter((c) => c.slug.length > 0);
      },
      getMyStatus: async () => statusSummaries,
      searchDocs: async ({ keywords }) => {
        const bySlug = new Map(
          docSections.map((d) => [`${d.docKey}#${d.sectionId}`, d])
        );
        const hits: ChatDocHit[] = [];
        for (const s of docKeywordScoreList(docSections, keywords)
          .filter((r) => r.score >= DOC_KEYWORD_MIN_SCORE)
          .slice(0, 3)) {
          const d = bySlug.get(s.slug);
          if (!d) continue;
          hits.push({
            key: s.slug,
            docTitle: d.docTitle,
            sectionTitle: d.sectionTitle,
            excerpt: d.text.slice(0, 300),
            url: docSectionUrl(d),
          });
        }
        return hits;
      },
      ...(kbEnabled
        ? {
            searchKb: async ({ query: kbQuery }) => {
              const hits = await searchKbMcp({
                url: kbUrl,
                token: kbToken,
                query: kbQuery,
              }).catch(() => []);
              return hits.map((h, i) => ({
                key: `sysmex-kb#kb-${i}`,
                docTitle: '企业知识库',
                sectionTitle: h.category ? `${h.title}` : h.title,
                excerpt: h.text.slice(0, 300),
                url: h.url ?? '',
              }));
            },
          }
        : {}),
    };

    const baseUrl = (await getConfig('openai_base_url'))?.trim() || '';
    const apiKey = (await getConfig('openai_api_key'))?.trim() || '';

    const result = await runAssistantChat({
      query,
      history,
      catalog,
      docSections,
      role,
      statusSummaries,
      tools,
      resolveCourse,
      docSectionUrl,
      baseUrl,
      apiKey,
      attachmentContext: attachmentContext || undefined,
      images: attachmentImages,
    });

    // 审计：只记模式/是否命中/课程数，不记原问句与历史。
    recordEvent({
      userId: session.user.id,
      kind: 'ai_assistant_query',
      detail: {
        mode: result.mode,
        routedBy: 'chat',
        found: result.found,
        courses: result.courses.length,
      },
    });

    return respData({
      ...result,
      role,
      status: statusSummaries,
      attachmentContext,
    });
  } catch {
    return respErr('对话服务暂时不可用，请稍后再试', { status: 503 });
  }
}

export const Route = createFileRoute('/api/ai-assistant/chat')({
  server: { handlers: { POST } },
});
