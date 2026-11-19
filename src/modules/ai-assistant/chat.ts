// 对话式 AI 学习助手：大圆式自由对话 + 系统 agent 工具接入。
//
// 与 runAssistantQuery（固定推荐流程）不同，这里由 LLM 决定何时调工具：
//   调工具只输出一个 JSON：
//     {"action":"tool","tool":"search_courses","args":{"keywords":"领导力"}}
//   直接回答用中文正文（不用 JSON），需要推荐课程或引用文档时在末尾另起
//   一行写「【推荐课程】course-xxx, course-yyy」或「【引用文档】<key>」。
//   （长中文答案放 JSON 字符串里常因未转义的换行/引号解析失败，之前会把
//   原始 JSON 直接显示给用户；正文+标记行避免了这个问题。）
// 服务端执行工具、把结果喂回 LLM，最多 3 轮工具调用；最后的 courses /
// sources 只认工具实际返回过的内容（seen 集），防模型编造卡片。
//
// Jev 不再做硬路由（不再有“与课程无关就直接回查不到”）；课程语义匹配由
// LLM 读工具结果完成。LLM 不可用时降级为关键词匹配 + 模板回答。
//
// 本模块是纯编排，不读数据库、不读配置：工具由调用方（API 路由）传入，
// 其中课程/分类工具走系统 agent（executeAdmin），状态/文档/知识库是
// 助手内部工具（无对应注册表操作，口径与 recommend 一致）。

import type { AssistantRole, StatusSummary } from './mcp';
import {
  AI_ASSISTANT_MODEL,
  assistantContextLines,
  DOC_KEYWORD_MIN_SCORE,
  docKeywordScoreList,
  keywordRecommend,
  type CourseCatalogItem,
  type DocCandidate,
  type DocSource,
  type RecommendedCourse,
} from './service';

export interface ChatHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

/** 工具返回的课程简述（不含链接；链接由 getCourse / 最终解析补）。 */
export interface ChatCourseBrief {
  id: string;
  slug: string;
  title: string;
  categories: string[];
  /** 管理员填的关键词（post.tags 拆出），LLM 读工具结果时作匹配参考。 */
  keywords?: string[];
  description: string;
}

/** 工具返回的文档命中（key 供最终答案引用，服务端按 seen 集校验）。 */
export interface ChatDocHit {
  key: string;
  docTitle: string;
  sectionTitle: string;
  excerpt: string;
  url: string;
}

export interface ChatTools {
  searchCourses: (args: {
    keywords: string;
  }) => Promise<ChatCourseBrief[] | { error: string }>;
  getCourse: (args: {
    slug: string;
  }) => Promise<RecommendedCourse | { error: string }>;
  listCategories: () => Promise<
    { slug: string; title: string }[] | { error: string }
  >;
  getMyStatus: () => Promise<StatusSummary[]>;
  searchDocs: (args: { keywords: string }) => Promise<ChatDocHit[]>;
  /** 仅管理员且配了 token 时提供；不提供时 LLM 看不到这个工具。 */
  searchKb?: (args: { query: string }) => Promise<ChatDocHit[]>;
}

export interface ChatResult {
  mode: 'chat' | 'keyword' | 'doc';
  found: boolean;
  answer: string;
  courses: RecommendedCourse[];
  sources: DocSource[];
}

export interface ChatInput {
  query: string;
  /** 多轮历史（调用方已截断：最多 10 轮，每条 ≤500 字）。 */
  history: ChatHistoryItem[];
  catalog: CourseCatalogItem[];
  docSections: DocCandidate[];
  role?: AssistantRole;
  statusSummaries?: StatusSummary[];
  tools: ChatTools;
  /** 由调用方把课程 slug 解析成完整课程（含链接；读不到返回 null）。 */
  resolveCourse: (slug: string) => Promise<RecommendedCourse | null>;
  docSectionUrl: (section: DocCandidate) => string;
  baseUrl: string;
  apiKey: string;
}

/** 工具循环上限：LLM 最多调 3 次工具，之后必须直接回答。 */
export const CHAT_MAX_TOOL_ROUNDS = 3;
/** 历史上限：最多带 10 轮（20 条消息）进 LLM。 */
export const CHAT_MAX_HISTORY_TURNS = 10;

const CHAT_LLM_TIMEOUT_MS = 60_000;

function toolDescriptions(tools: ChatTools): string {
  const lines = [
    'search_courses：按关键词找课程。参数 {"keywords": "…"}。返回课程的 id、slug、标题、分类、简介（不含链接）。想推荐课之前先调它。',
    'get_course：读一门课的详情与课程链接。参数 {"slug": "course-xxx"}（只能用 search_courses 返回过的 slug）。返回标题、简介、分类、课程链接、类型（视频课/文本课）。',
    'list_categories：列出全部课程分类。无参数。',
    'get_my_status：查提问人的带教状态（已按权限过滤：管理员看全部，学员只看自己，导师看自己带的学员）。无参数。想给学习建议、查带教进度时调它。',
    'search_docs：按关键词在入社培训文档里找相关章节。参数 {"keywords": "…"}。返回文档标题、章节标题、原文摘录、链接。',
  ];
  if (tools.searchKb) {
    lines.push(
      'search_kb：在企业知识库（SharePoint，全租户）里全局搜索文档。参数 {"query": "…"}。返回文件名、大小、原文链接，按站点分组。问制度、流程、请假、报销这类公司文档时调它。'
    );
  }
  return lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
}

function chatSystemPrompt(input: ChatInput): string {
  return [
    '你是企业大学 wiki 的 AI 学习助手，和企微里的大圆一样：能正常聊天，不只推课。',
    '用中文回答，简短直接，先给结论；一轮只答当前问题，不要一次列十几条。',
    '',
    '你有以下工具，需要查资料时调用，不要凭空编造课程名、链接、流程、联系人或电话：',
    toolDescriptions(input.tools),
    '',
    '调用规则：',
    '1. 调工具时只输出一个 JSON，不要解释文字：{"action":"tool","tool":"<工具名>","args":{...}}。',
    '2. 直接回答时用中文正文，不要用 JSON、不要用代码块；需要推荐课程或引用文档时，在回答末尾另起一行写「【推荐课程】course-xxx, course-yyy」或「【引用文档】<key1>, <key2>」，只填工具返回过的 slug/key，最多 2 个。',
    '3. 推荐课程时，只推工具返回过的课；课程链接由服务端从正文读取，你不要自己拼链接。',
    '4. 文档问题只按工具返回的原文回答；原文写“待填”“速览”或“细则以正式制度原文为准”时，如实说明，不要自己补一个流程。',
    '5. 问候、闲聊、与课程无关的问题，正常接话，不用拒绝，也不用硬推课。',
    '6. 不知道就直说不知道，不要编造。',
    ...assistantContextLines(input.role, input.statusSummaries),
  ].join('\n');
}

/**
 * 从正文回答里抽出末尾的推荐/引用标记行（【推荐课程】slug1, slug2 /
 * 【引用文档】key1, key2），返回去掉标记行的正文与标记内容。
 * 标记行不显示给用户，服务端按 seen 集校验后生成卡片。
 */
function extractMarkers(text: string): {
  text: string;
  courses: string[];
  docRefs: string[];
} {
  const courses: string[] = [];
  const docRefs: string[] = [];
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const cm = line.match(/【推荐课程】\s*(.+)/);
    if (cm) {
      courses.push(
        ...cm[1]
          .split(/[,，、]/)
          .map((s) => s.trim())
          .filter(Boolean)
      );
      continue;
    }
    const dm = line.match(/【引用文档】\s*(.+)/);
    if (dm) {
      docRefs.push(
        ...dm[1]
          .split(/[,，、]/)
          .map((s) => s.trim())
          .filter(Boolean)
      );
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join('\n').trim(), courses, docRefs };
}

interface LlmJson {
  action?: string;
  tool?: string;
  args?: Record<string, unknown>;
  answer?: string;
  courses?: unknown;
  docRefs?: unknown;
}

function parseLlmJson(text: string): LlmJson | null {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    return parsed as LlmJson;
  } catch {
    return null;
  }
}

/** 调 OpenAI 兼容的 chat completions（本机部署指向 Magpie 网关），返回原文。 */
async function callChatLLM({
  baseUrl,
  apiKey,
  model = AI_ASSISTANT_MODEL,
  messages,
}: {
  baseUrl: string;
  apiKey: string;
  model?: string;
  messages: { role: string; content: string }[];
}): Promise<string | null> {
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
        max_tokens: 1024,
        messages,
      }),
      signal: AbortSignal.timeout(CHAT_LLM_TIMEOUT_MS),
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
  return content || null;
}

function isErrorResult(v: unknown): v is { error: string } {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { error?: unknown }).error === 'string'
  );
}

/**
 * 执行一次工具调用（名字与参数都校验过才执行；未知工具或参数不对时
 * 返回错误文本给 LLM，不抛错）。
 */
async function runTool(
  tools: ChatTools,
  name: string,
  args: Record<string, unknown>
): Promise<{ text: string; courses: ChatCourseBrief[]; docs: ChatDocHit[] }> {
  const courses: ChatCourseBrief[] = [];
  const docs: ChatDocHit[] = [];
  const fail = (msg: string) => ({
    text: `工具 ${name} 调用失败：${msg}`,
    courses,
    docs,
  });
  try {
    switch (name) {
      case 'search_courses': {
        const keywords = String(args.keywords ?? '').trim();
        if (!keywords) return fail('keywords 不能为空');
        const r = await tools.searchCourses({ keywords });
        if (isErrorResult(r)) return fail(r.error);
        courses.push(...r);
        if (r.length === 0)
          return { text: '没有找到相关课程。', courses, docs };
        return {
          text: JSON.stringify(
            r.map((c) => ({
              slug: c.slug,
              title: c.title,
              categories: c.categories,
              keywords: c.keywords ?? [],
              description: c.description.slice(0, 120),
            }))
          ),
          courses,
          docs,
        };
      }
      case 'get_course': {
        const slug = String(args.slug ?? '').trim();
        if (!slug) return fail('slug 不能为空');
        const r = await tools.getCourse({ slug });
        if (isErrorResult(r)) return fail(r.error);
        courses.push({
          id: '',
          slug: r.slug,
          title: r.title,
          categories: r.categories,
          keywords: r.keywords ?? [],
          description: r.description,
        });
        return {
          text: JSON.stringify({
            slug: r.slug,
            title: r.title,
            categories: r.categories,
            keywords: r.keywords ?? [],
            description: r.description.slice(0, 300),
            link: r.link,
            type: r.type,
          }),
          courses,
          docs,
        };
      }
      case 'list_categories': {
        const r = await tools.listCategories();
        if (isErrorResult(r)) return fail(r.error);
        return { text: JSON.stringify(r), courses, docs };
      }
      case 'get_my_status': {
        const rows = await tools.getMyStatus();
        if (rows.length === 0)
          return { text: '没有查到带教状态。', courses, docs };
        return {
          text: JSON.stringify(
            rows.slice(0, 5).map((s) => ({
              name: s.name,
              department: s.department,
              planType: s.planType,
              status: s.status,
              result: s.result,
              expectedDate: s.expectedDate,
              flags: s.flags,
            }))
          ),
          courses,
          docs,
        };
      }
      case 'search_docs': {
        const keywords = String(args.keywords ?? '').trim();
        if (!keywords) return fail('keywords 不能为空');
        const r = await tools.searchDocs({ keywords });
        docs.push(...r);
        if (r.length === 0)
          return { text: '文档里没有找到相关章节。', courses, docs };
        return {
          text: JSON.stringify(
            r.map((d) => ({
              key: d.key,
              docTitle: d.docTitle,
              sectionTitle: d.sectionTitle,
              excerpt: d.excerpt.slice(0, 300),
              url: d.url,
            }))
          ),
          courses,
          docs,
        };
      }
      case 'search_kb': {
        if (!tools.searchKb) return fail('知识库检索未启用');
        const query = String(args.query ?? '').trim();
        if (!query) return fail('query 不能为空');
        const r = await tools.searchKb({ query });
        docs.push(...r);
        if (r.length === 0)
          return { text: '知识库里没有找到相关文档。', courses, docs };
        return {
          text: JSON.stringify(
            r.map((d) => ({
              key: d.key,
              docTitle: d.docTitle,
              sectionTitle: d.sectionTitle,
              excerpt: d.excerpt.slice(0, 300),
              url: d.url,
            }))
          ),
          courses,
          docs,
        };
      }
      default:
        return fail('没有这个工具');
    }
  } catch {
    return fail('执行出错');
  }
}

/** LLM 不可用时的降级：关键词找课 + 文档关键词，模板回答。 */
async function fallbackChat(input: ChatInput): Promise<ChatResult> {
  const { query, catalog, docSections, resolveCourse, docSectionUrl } = input;
  const courses: RecommendedCourse[] = [];
  for (const slug of keywordRecommend(catalog, query)) {
    const c = await resolveCourse(slug).catch(() => null);
    if (!c) continue;
    const item = catalog.find((x) => x.slug === slug);
    if (!item) continue;
    courses.push({ ...item, type: c.type, link: c.link });
  }
  const sources: DocSource[] = [];
  const bySlug = new Map(
    docSections.map((d) => [`${d.docKey}#${d.sectionId}`, d])
  );
  for (const s of docKeywordScoreList(docSections, query)
    .filter((r) => r.score >= DOC_KEYWORD_MIN_SCORE)
    .slice(0, 2)) {
    const d = bySlug.get(s.slug);
    if (!d) continue;
    sources.push({
      docTitle: d.docTitle,
      sectionTitle: d.sectionTitle,
      url: docSectionUrl(d),
    });
  }
  const found = courses.length > 0 || sources.length > 0;
  const answer = found
    ? '模型暂时不可用，按关键词找到以下内容，供你参考。'
    : '模型暂时不可用，也没找到相关课程或文档，换个关键词试试。';
  return {
    mode: found && courses.length > 0 ? 'keyword' : 'doc',
    found,
    answer,
    courses,
    sources,
  };
}

/**
 * 对话式问答主循环：LLM 决策 → 调工具 → 再决策 → 回答。
 * 最终答案的 courses / docRefs 只认工具实际返回过的内容。
 */
export async function runAssistantChat(input: ChatInput): Promise<ChatResult> {
  const { query, baseUrl, apiKey } = input;
  if (!baseUrl || !apiKey) return fallbackChat(input);

  const history = input.history.slice(-CHAT_MAX_HISTORY_TURNS * 2);
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: chatSystemPrompt(input) },
    ...history.map((h) => ({ role: h.role, content: h.content.slice(0, 500) })),
    { role: 'user', content: query },
  ];

  const seenCourses = new Map<string, ChatCourseBrief>();
  const seenDocs = new Map<string, ChatDocHit>();
  let toolRounds = 0;
  let iterations = 0;
  let formatRetries = 0;
  let finalAnswer: string | null = null;
  let finalCourses: string[] = [];
  let finalDocRefs: string[] = [];

  // 总轮数硬上限（工具轮 + 强制回答轮 + 余量），防模型一直调工具。
  const maxIterations = CHAT_MAX_TOOL_ROUNDS + 2;
  for (;;) {
    if (++iterations > maxIterations) return fallbackChat(input);
    const raw = await callChatLLM({ baseUrl, apiKey, messages });
    if (!raw) return fallbackChat(input);
    const parsed = parseLlmJson(raw);
    if (parsed && parsed.action === 'tool' && typeof parsed.tool === 'string') {
      if (toolRounds >= CHAT_MAX_TOOL_ROUNDS) {
        messages.push({ role: 'assistant', content: raw });
        messages.push({
          role: 'user',
          content:
            '工具调用已达上限，请直接用中文正文回答，不要再调工具，也不要输出 JSON。',
        });
        continue;
      }
      toolRounds += 1;
      const result = await runTool(input.tools, parsed.tool, parsed.args ?? {});
      for (const c of result.courses) seenCourses.set(c.slug, c);
      for (const d of result.docs) seenDocs.set(d.key, d);
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content: `工具 ${parsed.tool} 返回：${result.text}`,
      });
      continue;
    }
    if (parsed && parsed.action === 'answer') {
      // 兼容旧格式的 JSON 回答（提示词已改成正文+标记行，模型偶尔仍回 JSON）。
      finalAnswer = String(parsed.answer ?? '').trim() || raw;
      finalCourses = Array.isArray(parsed.courses)
        ? parsed.courses.filter((s): s is string => typeof s === 'string')
        : [];
      finalDocRefs = Array.isArray(parsed.docRefs)
        ? parsed.docRefs.filter((s): s is string => typeof s === 'string')
        : [];
      break;
    }
    if (!parsed && raw.trim().startsWith('{')) {
      // 看着像 JSON 但解析失败（长中文答案里常有未转义的换行/引号）：
      // 绝不把原始 JSON 显示给用户；让模型用正文重答一次，重答仍失败
      // 则走关键词降级。
      if (formatRetries < 1) {
        formatRetries += 1;
        messages.push({ role: 'assistant', content: raw });
        messages.push({
          role: 'user',
          content:
            '你刚才的回复格式不对。请直接用中文正文回答，不要输出 JSON，也不要输出代码块；需要推荐课程或引用文档时，在回答末尾另起一行写「【推荐课程】课程slug1, 课程slug2」或「【引用文档】引用key1, 引用key2」。',
        });
        continue;
      }
      return fallbackChat(input);
    }
    if (parsed) {
      // 合法 JSON 但 action 未知：同上，用正文重答一次。
      if (formatRetries < 1) {
        formatRetries += 1;
        messages.push({ role: 'assistant', content: raw });
        messages.push({
          role: 'user',
          content:
            '请直接用中文正文回答，不要输出 JSON；需要推荐课程或引用文档时，在回答末尾另起一行写「【推荐课程】课程slug1, 课程slug2」或「【引用文档】引用key1, 引用key2」。',
        });
        continue;
      }
      return fallbackChat(input);
    }
    // 正文回答：抽出末尾的推荐/引用标记行，剩余正文显示给用户。
    const marked = extractMarkers(raw);
    finalAnswer = marked.text;
    finalCourses = marked.courses;
    finalDocRefs = marked.docRefs;
    break;
  }

  if (!finalAnswer) return fallbackChat(input);

  // 最终卡片只认工具返回过的内容：课程解析链接，文档按 key 取来源。
  const courses: RecommendedCourse[] = [];
  for (const slug of finalCourses.slice(0, 2)) {
    if (!seenCourses.has(slug)) continue;
    const item = input.catalog.find((c) => c.slug === slug);
    if (!item) continue;
    const resolved = await input.resolveCourse(slug).catch(() => null);
    if (!resolved) continue;
    courses.push({ ...item, type: resolved.type, link: resolved.link });
  }
  const sources: DocSource[] = [];
  for (const key of finalDocRefs.slice(0, 2)) {
    const hit = seenDocs.get(key);
    if (!hit) continue;
    sources.push({
      docTitle: hit.docTitle,
      sectionTitle: hit.sectionTitle,
      url: hit.url,
    });
  }
  const found = courses.length > 0 || sources.length > 0;
  return {
    mode: 'chat',
    found,
    answer: finalAnswer.slice(0, 2000),
    courses,
    sources,
  };
}
