// AI 学习助手的工具层（MCP）：数据直接读 blog 数据库的表（post / user /
// user_status_summary），不走 blog 的 HTTP/MCP 接口；企业知识库走
// sysmex-kb MCP（Streamable HTTP）。
//
// 权限：状态抽取按调用方身份过滤——管理员看全部；学员只看自己（按工号）；
// 导师看自己带的学员（按带教负责人姓名匹配；姓名在表里对应多个不同带教
// 人时宁可不给，不猜）。调用方身份与 admin 判定由 API 路由算好，以 scope
// 传入；本模块只按 scope 查表，不读会话、不判权限。
//
// sysmex-kb：URL 与 token 由调用方从配置表传入（设置页 AI → 知识库 MCP），
// 未配或调用失败时返回空数组，助手退回本地文档链路，不阻塞问答。token
// 只出现在发往该 MCP 的 Authorization 头里，绝不记日志、不进事件。

import { desc, eq } from 'drizzle-orm';

import { db } from '@/core/db';
import { userStatusSummary, type UserStatusSummary } from '@/config/db/schema';

/** 角色三档：销售 / 应用（应用支持）/ 客服。后端维度，助手页暂不显示切换。 */
export type AssistantRole = 'sales' | 'application' | 'service';

/** 接受英文或中文角色名，其他一律回默认（应用）。 */
export function parseAssistantRole(value: unknown): AssistantRole {
  if (value === 'sales' || value === '销售') return 'sales';
  if (value === 'service' || value === '客服') return 'service';
  return 'application';
}

/** 按学员所在部门推断角色：销售部门→销售，客服→客服，其余→应用。 */
export function inferRoleFromDepartment(
  department: string | null | undefined
): AssistantRole {
  const d = department ?? '';
  if (d.includes('销售')) return 'sales';
  if (d.includes('客服')) return 'service';
  return 'application';
}

export type StatusScope =
  | { kind: 'admin' }
  | { kind: 'self'; employeeNo: string | null; name: string | null };

/** 助手可见的学员状态快照（已按权限过滤，不含企微/内部 id）。 */
export interface StatusSummary {
  id: string;
  name: string;
  employeeNo: string | null;
  department: string | null;
  positionName: string | null;
  planType: string | null;
  planStartDate: string | null;
  planEndDate: string | null;
  expectedDate: string | null;
  status: string | null;
  result: string | null;
  /** 带教过程分值 / 绩点 / E-learning 得分（与同步脚本的 actual.scores 一致）。 */
  scores: { process?: number; gpa?: number; elearn?: number } | null;
  flags: string[];
  computedAt: string | null;
}

const STATUS_LIMIT = 200;
const SELF_STATUS_LIMIT = 50;

function toStatusSummary(row: UserStatusSummary): StatusSummary {
  let actual: any = null;
  try {
    actual = row.actual ? JSON.parse(row.actual) : null;
  } catch {
    actual = null;
  }
  let flags: string[] = [];
  try {
    const f = row.flags ? JSON.parse(row.flags) : [];
    if (Array.isArray(f))
      flags = f.filter((x): x is string => typeof x === 'string');
  } catch {
    flags = [];
  }
  return {
    id: row.id,
    name: row.name,
    employeeNo: row.employeeNo,
    department: row.department,
    positionName: row.positionName,
    planType: row.planType,
    planStartDate: row.planStartDate,
    planEndDate: row.planEndDate,
    expectedDate: row.expectedDate,
    status: actual?.status ?? null,
    result: actual?.result ?? null,
    scores: actual?.scores ?? null,
    flags,
    computedAt: row.computedAt ? new Date(row.computedAt).toISOString() : null,
  };
}

/**
 * 按 scope 读 user_status_summary（直接读表，不走 blog 的 HTTP/MCP 接口）。
 * 管理员：全部（按更新时间倒序，上限 200 行）。
 * 学员/导师：自己的行（工号）＋自己带的学员行（带教负责人姓名）；姓名
 * 对应多个不同带教人时导师范围直接置空，不猜。
 */
export async function readStatusForCaller(
  scope: StatusScope
): Promise<StatusSummary[]> {
  if (scope.kind === 'admin') {
    const rows = await db()
      .select()
      .from(userStatusSummary)
      .orderBy(desc(userStatusSummary.updatedAt))
      .limit(STATUS_LIMIT);
    return rows.map(toStatusSummary);
  }
  const byId = new Map<string, UserStatusSummary>();
  if (scope.employeeNo) {
    const rows = await db()
      .select()
      .from(userStatusSummary)
      .where(eq(userStatusSummary.employeeNo, scope.employeeNo))
      .limit(SELF_STATUS_LIMIT);
    for (const r of rows) byId.set(r.id, r);
  }
  if (scope.name) {
    const rows = await db()
      .select()
      .from(userStatusSummary)
      .where(eq(userStatusSummary.mentorLeadName, scope.name))
      .limit(SELF_STATUS_LIMIT);
    const leadIds = new Set(rows.map((r) => r.mentorLeadId).filter(Boolean));
    if (rows.length > 0 && leadIds.size <= 1) {
      for (const r of rows) byId.set(r.id, r);
    } else if (leadIds.size > 1) {
      // 同名不同人：宁可不给，不猜；不记姓名，只记一次。
      console.warn(
        '[ai-assistant] ambiguous mentor name, mentor scope skipped'
      );
    }
  }
  return [...byId.values()]
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
    .map(toStatusSummary);
}

// ---------------------------------------------------------------------------
// sysmex-kb MCP（Streamable HTTP，工具名事先未知，按 tools/list 自适应）
// ---------------------------------------------------------------------------

export interface KbHit {
  title: string;
  text: string;
  url?: string;
}

const KB_TIMEOUT_MS = 8_000;
const KB_MAX_HITS = 3;
const KB_MAX_TEXT = 1500;

/** 一次 MCP POST：Streamable HTTP 回 SSE `data:` 行，部分实现回纯 JSON。 */
async function mcpPost(
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number
): Promise<any | null> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const text = await resp.text();
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    try {
      const j = JSON.parse(t.slice(5).trim());
      if (j && typeof j === 'object') return j;
    } catch {
      // 不是 JSON 的 data 行，继续找下一行。
    }
  }
  return null;
}

/** 挑检索工具：名字/描述含 search/query/global/find 的优先，其次看入参。 */
function pickSearchTool(tools: any[]): any | null {
  if (tools.length === 0) return null;
  const byName = tools.find((t) =>
    /search|query|global|find/i.test(`${t?.name ?? ''} ${t?.description ?? ''}`)
  );
  if (byName) return byName;
  const byParam = tools.find((t) => {
    const props = t?.inputSchema?.properties ?? {};
    return Object.keys(props).some((k) =>
      /^(query|keyword|keywords|text|q)$/i.test(k)
    );
  });
  return byParam ?? tools[0];
}

/**
 * 按工具的 inputSchema 拼参数：问句类字段填用户问题；其他必填字符串字段
 * 填空串；其余不管。服务端校验不过时调用方返回空（不抛错）。
 */
function buildToolArgs(tool: any, query: string): Record<string, unknown> {
  const props: Record<string, any> = tool?.inputSchema?.properties ?? {};
  const required: string[] = Array.isArray(tool?.inputSchema?.required)
    ? tool.inputSchema.required
    : [];
  const args: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(props)) {
    if (schema?.type !== 'string') continue;
    if (/query|keyword|text|question|^q$/i.test(key)) args[key] = query;
    else if (required.includes(key)) args[key] = '';
  }
  return args;
}

function parseKbHits(result: any, toolName: string): KbHit[] {
  const blocks: any[] = Array.isArray(result?.content) ? result.content : [];
  const text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(text);
    const items: any[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.results)
        ? parsed.results
        : Array.isArray(parsed?.items)
          ? parsed.items
          : [parsed];
    return items
      .slice(0, KB_MAX_HITS)
      .map((it) => {
        const t = String(it?.text ?? it?.content ?? it?.snippet ?? '').trim();
        const title = String(
          it?.title ?? it?.name ?? t.slice(0, 40) ?? toolName
        ).trim();
        const url =
          typeof it?.url === 'string'
            ? it.url
            : typeof it?.href === 'string'
              ? it.href
              : undefined;
        return { title: title || toolName, text: t.slice(0, KB_MAX_TEXT), url };
      })
      .filter((h) => h.text.length > 0);
  } catch {
    return [{ title: toolName, text: text.slice(0, KB_MAX_TEXT) }];
  }
}

/**
 * 调 sysmex-kb MCP 检索一次。任何一步失败（未配、超时、工具为空、
 * 服务端报错）都返回 []，由调用方退回本地文档链路。
 */
export async function searchKbMcp({
  url,
  token,
  query,
  timeoutMs = KB_TIMEOUT_MS,
}: {
  url: string;
  token: string;
  query: string;
  timeoutMs?: number;
}): Promise<KbHit[]> {
  const endpoint = url.trim().replace(/\/+$/, '');
  if (!endpoint || !token || !query.trim()) return [];
  const init = await mcpPost(
    endpoint,
    token,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'wiki-ai-assistant', version: '1' },
      },
    },
    timeoutMs
  );
  if (!init?.result) return [];
  // initialized 通知不需要响应，失败也不阻塞。
  mcpPost(
    endpoint,
    token,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    timeoutMs
  ).catch(() => {});
  const listed = await mcpPost(
    endpoint,
    token,
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    timeoutMs
  );
  const tools: any[] = listed?.result?.tools ?? [];
  const tool = pickSearchTool(tools);
  if (!tool) return [];
  const called = await mcpPost(
    endpoint,
    token,
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: tool.name, arguments: buildToolArgs(tool, query) },
    },
    timeoutMs
  );
  if (!called?.result || called?.error) return [];
  return parseKbHits(called.result, tool.name);
}

/** 像查制度/流程/入职文档的问题才走知识库 MCP（课程问题不走）。 */
const KB_QUERY_HINT_RE =
  /入职|入社|制度|流程|请假|考勤|报销|审批|开通|权限|休假|转正|离职|社保|公积金|用印|采购|差旅|手册|指南|FAQ|常见问题|怎么办理|哪里|入口/;

export function looksLikeKbQuery(query: string): boolean {
  return KB_QUERY_HINT_RE.test(query);
}
