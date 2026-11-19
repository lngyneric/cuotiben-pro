import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

import { useSession } from '@/core/auth/client';
import { Link } from '@/core/i18n/navigation';
import { localizedAbsoluteUrl } from '@/core/i18n/urls';
import { envConfigs } from '@/config';
import { apiGet } from '@/lib/api-client';
import { withAppBase } from '@/lib/base-path';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';
import { getLocale, locales } from '@/paraglide/runtime.js';
import { Footer } from '@/blocks/footer';
import { Header } from '@/blocks/header';
import { buttonVariants } from '@/components/ui/button';
import graphData from '@/content/graph/graph.json';
import treeData from '@/content/graph/ivd-tree.json';

import {
  VisualGraph,
  type VisualItem,
  type VisualLink,
} from './graph/-visual-graph';

interface GraphNodeData {
  title?: string;
  color?: string;
  description?: string;
  difficulty?: number;
  estimatedHours?: number;
  keyTopics?: string[];
  instruments?: string[];
  parameters?: string[];
  clinicalApps?: string[];
  regulations?: string[];
  salesKpi?: string;
  sourcePpt?: string;
  audience?: string;
  domainId?: string;
  shifuBid?: string;
  slug?: string;
  status?: string;
  postTitle?: string;
  lessonCount?: number;
  keywords?: string;
  docKey?: string;
  sectionId?: string;
  docTitle?: string;
  category?: string;
  url?: string;
  role?: string;
  note?: string;
  siteUrl?: string;
  extractionStatus?: string;
}

interface GraphNode {
  id: string;
  label: string;
  class: string;
  data: GraphNodeData;
}

interface GraphEdge {
  source: string;
  property: string;
  target: string;
  data?: Record<string, unknown>;
}

interface GraphFile {
  version: string;
  date: string;
  generatedAt: string;
  treeVersion: string;
  counts: Record<string, number | string>;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface OverlayCourse {
  bid: string;
  slug: string;
  title: string;
  status: string;
}

interface OverlayLink {
  nodeId: string;
  courseBid: string;
  score: number;
}

interface OverlayCounts {
  publishedCourses: number;
  linkedCourses: number;
  linkTotal: number;
}

interface OverlayDoc {
  docKey: string;
  docTitle: string;
  sectionId: string;
  sectionTitle: string;
  url: string;
}

interface PeopleMentee {
  name: string;
  employeeNo: string | null;
  planType: string | null;
  status: string | null;
  flags: string[];
  scores: Record<string, number> | null;
  coursesTaken: number;
  lastActivityAt: string | null;
  recommendation: {
    bid: string;
    title: string;
    slug: string;
    reason: string;
  } | null;
  recommendReason: string;
}

interface PeopleMentor {
  id: string;
  name: string;
  employeeNo: string | null;
  mentorTypes: string[];
  mentees: PeopleMentee[];
}

interface PeopleData {
  scope: 'admin' | 'mentor';
  mentors: PeopleMentor[];
}

const GRAPH = graphData as unknown as GraphFile;

const TREE = treeData as unknown as {
  learning_paths_detail: Record<
    string,
    {
      name: string;
      intro: string;
      total_credits: number;
      stages: { stage: number; name: string; desc: string; nodes: string[] }[];
    }
  >;
};

const PATH_KEYS = ['sales', 'technical', 'lab'] as const;
type PathKey = (typeof PATH_KEYS)[number];
const PATH_LABEL: Record<PathKey, string> = {
  sales: 'graph.stage_path_sales',
  technical: 'graph.stage_path_technical',
  lab: 'graph.stage_path_lab',
};

type Role = 'all' | 'sales' | 'application' | 'service';
type Axis = 'domain' | 'stage' | 'people';
type ViewMode = 'list' | 'visual';

const ROLES: { key: Role; labelKey: string }[] = [
  { key: 'all', labelKey: 'graph.role_all' },
  { key: 'sales', labelKey: 'graph.role_sales' },
  { key: 'application', labelKey: 'graph.role_application' },
  { key: 'service', labelKey: 'graph.role_service' },
];

const STATUS_LABEL: Record<string, string> = {
  published: 'graph.status_published',
  draft: 'graph.status_draft',
};

function statusText(status: string | undefined, liveStatus?: string): string {
  const s = liveStatus ?? status;
  if (s === 'published') return m['graph.status_published']();
  if (s === 'draft') return m['graph.status_draft']();
  if (s === '未入库') return m['graph.status_not_in_library']();
  return m['graph.status_unknown']();
}

export const Route = createFileRoute('/graph')({
  loader: async () => {
    const locale = getLocale();
    return { locale };
  },
  head: ({ loaderData }) => {
    const locale = loaderData?.locale ?? 'zh';
    const urlFor = (loc: string) => localizedAbsoluteUrl('/graph', loc);
    return {
      meta: [
        {
          title: `${m['graph.title']({}, { locale: locale as any })} | ${envConfigs.app_name}`,
        },
        {
          name: 'description',
          content: m['graph.description']({}, { locale: locale as any }),
        },
      ],
      links: [
        { rel: 'canonical', href: urlFor(locale) },
        ...locales.map((loc) => ({
          rel: 'alternate',
          hrefLang: loc,
          href: urlFor(loc),
        })),
      ],
    };
  },
  component: GraphPage,
});

function GraphPage() {
  const { data: session, isPending: sessionPending } = useSession();
  const [role, setRole] = useState<Role>('all');
  const [domainId, setDomainId] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [axis, setAxis] = useState<Axis>('domain');
  const [pathKey, setPathKey] = useState<PathKey>('sales');
  const [mentorId, setMentorId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      return (
        (localStorage.getItem('graph-view-mode') as ViewMode | null) || 'list'
      );
    } catch {
      return 'list';
    }
  });
  const sectionRef = useRef<HTMLElement>(null);

  // 实时叠加：课程发布状态＋动态课程关联＋文档清单；失败时用构建时状态降级展示。
  const overlayQ = useQuery({
    queryKey: ['graph-overlay'],
    queryFn: () =>
      apiGet<{
        courses: OverlayCourse[];
        links: OverlayLink[];
        counts: OverlayCounts;
        docs: OverlayDoc[];
      }>('/api/graph'),
    staleTime: 60_000,
    retry: false,
  });
  // 人员轴：管理员/导师才有数据；其他人 403，tab 自动隐藏。
  const peopleQ = useQuery({
    queryKey: ['graph-people'],
    queryFn: () => apiGet<PeopleData>('/api/graph/people'),
    staleTime: 60_000,
    retry: false,
  });
  const liveCourseStatus = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of overlayQ.data?.courses ?? []) map.set(c.bid, c.status);
    return map;
  }, [overlayQ.data]);
  const liveCourseByBid = useMemo(() => {
    const map = new Map<string, OverlayCourse>();
    for (const c of overlayQ.data?.courses ?? []) map.set(c.bid, c);
    return map;
  }, [overlayQ.data]);
  // 动态关联：节点 → 课程 bid（定时同步写 graph_course_link 表）。
  const dynamicLinksByNode = useMemo(() => {
    const map = new Map<string, OverlayLink[]>();
    for (const l of overlayQ.data?.links ?? []) {
      const list = map.get(l.nodeId) ?? [];
      list.push(l);
      map.set(l.nodeId, list);
    }
    return map;
  }, [overlayQ.data]);
  const liveDocKeys = useMemo(() => {
    const set = new Set<string>();
    for (const d of overlayQ.data?.docs ?? [])
      set.add(`${d.docKey}#${d.sectionId}`);
    return set;
  }, [overlayQ.data]);

  const nodesById = useMemo(
    () => new Map(GRAPH.nodes.map((n) => [n.id, n])),
    []
  );
  const edgesBySource = useMemo(() => {
    const map = new Map<string, GraphEdge[]>();
    for (const e of GRAPH.edges) {
      const list = map.get(e.source) ?? [];
      list.push(e);
      map.set(e.source, list);
    }
    return map;
  }, []);

  const visibleDomains = useMemo(() => {
    const all = GRAPH.nodes.filter((n) => n.class === 'Domain');
    if (role === 'all') return all;
    const ids = new Set(
      (edgesBySource.get(`role:${role}`) ?? [])
        .filter((e) => e.property === 'roleIncludesDomain')
        .map((e) => e.target)
    );
    return all.filter((d) => ids.has(d.id));
  }, [role, edgesBySource]);

  const visibleNodeIds = useMemo(() => {
    if (role === 'all')
      return new Set(
        GRAPH.nodes.filter((n) => n.class === 'KnowledgeNode').map((n) => n.id)
      );
    return new Set(
      (edgesBySource.get(`role:${role}`) ?? [])
        .filter((e) => e.property === 'roleIncludesNode')
        .map((e) => e.target)
    );
  }, [role, edgesBySource]);

  const activeDomain = useMemo(() => {
    if (domainId && visibleDomains.some((d) => d.id === domainId))
      return nodesById.get(domainId);
    return visibleDomains[0];
  }, [domainId, visibleDomains, nodesById]);

  const domainNodes = useMemo(() => {
    if (!activeDomain) return [];
    return (edgesBySource.get(activeDomain.id) ?? [])
      .filter(
        (e) => e.property === 'domainHasNode' && visibleNodeIds.has(e.target)
      )
      .map((e) => nodesById.get(e.target))
      .filter((n): n is GraphNode => !!n);
  }, [activeDomain, edgesBySource, visibleNodeIds, nodesById]);

  const selectedNode = nodeId ? nodesById.get(nodeId) : undefined;

  const nodeEdges = useMemo(() => {
    if (!selectedNode)
      return {
        courses: [],
        docs: [],
        related: [] as { label: string; node: GraphNode; prop: string }[],
      };
    const out = edgesBySource.get(selectedNode.id) ?? [];
    const courses = out
      .filter((e) => e.property === 'nodeHasCourse')
      .map((e) => nodesById.get(e.target))
      .filter((n): n is GraphNode => !!n);
    // 动态关联：定时同步把 blog 已发布课链到节点，静态边里没有的在这里补上。
    const seenBids = new Set(
      courses.map((c) => c.data.shifuBid).filter((b): b is string => !!b)
    );
    for (const l of dynamicLinksByNode.get(selectedNode.id) ?? []) {
      if (seenBids.has(l.courseBid)) continue;
      const c = liveCourseByBid.get(l.courseBid);
      if (!c) continue;
      seenBids.add(l.courseBid);
      courses.push({
        id: `course:${l.courseBid}`,
        label: c.title || l.courseBid,
        class: 'Course',
        data: {
          shifuBid: l.courseBid,
          slug: c.slug,
          status: c.status,
        },
      });
    }
    const docs = out
      .filter((e) => e.property === 'nodeHasDoc')
      .map((e) => nodesById.get(e.target))
      .filter((n): n is GraphNode => !!n);
    const related = out
      .filter((e) =>
        ['nodePrerequisite', 'nodeExtends', 'nodeParallel'].includes(e.property)
      )
      .map((e) => ({ label: e.property, node: nodesById.get(e.target) }))
      .filter((r): r is { label: string; node: GraphNode } => !!r.node);
    return { courses, docs, related };
  }, [
    selectedNode,
    edgesBySource,
    nodesById,
    dynamicLinksByNode,
    liveCourseByBid,
  ]);

  // 课程总数改走实时数据：静态 graph.json 只有 TREE 快照的 9 门，blog 已发布
  // 课更多；已关联数 = 静态边去重后＋动态关联去重后。
  const liveCounts = useMemo(() => {
    const staticLinked = new Set<string>();
    for (const e of GRAPH.edges) {
      if (e.property === 'nodeHasCourse' && e.target.startsWith('course:'))
        staticLinked.add(e.target.slice('course:'.length));
    }
    const dynLinked = new Set(
      (overlayQ.data?.links ?? []).map((l) => l.courseBid)
    );
    const linked = new Set([...staticLinked, ...dynLinked]);
    return {
      linkedCourses: overlayQ.data?.counts
        ? linked.size
        : Number(GRAPH.counts.courses ?? 0),
      publishedCourses: overlayQ.data?.counts?.publishedCourses ?? null,
    };
  }, [overlayQ.data]);

  // 可视化图数据：可见领域＋可见节点＋其课程（已发布优先），边为领域—节点／
  // 节点关系／节点—课程。
  const visualData = useMemo(() => {
    const items: VisualItem[] = [];
    const links: VisualLink[] = [];
    const domainColor = new Map<string, string>();
    for (const d of visibleDomains) {
      domainColor.set(d.id, d.data.color || '#6b7280');
      items.push({
        id: d.id,
        label: d.label,
        kind: 'domain',
        color: d.data.color || '#6b7280',
      });
    }
    const nodeDomain = new Map<string, string>();
    for (const e of GRAPH.edges) {
      if (e.property === 'domainHasNode') nodeDomain.set(e.target, e.source);
    }
    const courseSeen = new Set<string>();
    for (const n of GRAPH.nodes) {
      if (n.class !== 'KnowledgeNode' || !visibleNodeIds.has(n.id)) continue;
      const dId = nodeDomain.get(n.id);
      items.push({
        id: n.id,
        label: n.label,
        kind: 'node',
        color: domainColor.get(dId ?? '') || '#059669',
      });
      if (dId) links.push({ source: dId, target: n.id, kind: 'domain' });
    }
    for (const e of GRAPH.edges) {
      if (
        !['nodePrerequisite', 'nodeExtends', 'nodeParallel'].includes(
          e.property
        )
      )
        continue;
      if (!visibleNodeIds.has(e.source) || !visibleNodeIds.has(e.target))
        continue;
      links.push({ source: e.source, target: e.target, kind: 'rel' });
    }
    // 课程节点：静态边＋动态关联，只取已发布课。
    const addCourse = (nodeId: string, bid: string) => {
      const c = liveCourseByBid.get(bid);
      if (!c || c.status !== 'published') return;
      if (courseSeen.has(bid)) return;
      courseSeen.add(bid);
      items.push({
        id: `course:${bid}`,
        label: c.title || bid,
        kind: 'course',
        color: '#d97706',
        status: c.status,
      });
      links.push({ source: nodeId, target: `course:${bid}`, kind: 'course' });
    };
    for (const e of GRAPH.edges) {
      if (e.property !== 'nodeHasCourse') continue;
      if (!visibleNodeIds.has(e.source)) continue;
      if (e.target.startsWith('course:'))
        addCourse(e.source, e.target.slice('course:'.length));
    }
    for (const [nodeId, list] of dynamicLinksByNode) {
      if (!visibleNodeIds.has(nodeId)) continue;
      for (const l of list) addCourse(nodeId, l.courseBid);
    }
    return { items, links };
  }, [visibleDomains, visibleNodeIds, dynamicLinksByNode, liveCourseByBid]);

  // 每节点已发布课数（静态边＋动态关联去重），阶段轴用。
  const nodeCourseCount = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (nodeId: string, bid: string) => {
      const c = liveCourseByBid.get(bid);
      if (!c || c.status !== 'published') return;
      const set = map.get(nodeId) ?? new Set<string>();
      set.add(bid);
      map.set(nodeId, set);
    };
    for (const e of GRAPH.edges) {
      if (e.property === 'nodeHasCourse' && e.target.startsWith('course:'))
        add(e.source, e.target.slice('course:'.length));
    }
    for (const [nodeId, list] of dynamicLinksByNode) {
      for (const l of list) add(nodeId, l.courseBid);
    }
    const out = new Map<string, number>();
    for (const [k, v] of map) out.set(k, v.size);
    return out;
  }, [dynamicLinksByNode, liveCourseByBid]);

  // 选节点或换领域后滚到详情顶部（修底部按钮点后视口停在下方留空白的问题）。
  // section 带 scroll-mt，滚到顶时标题不被置顶导航栏遮住。
  useEffect(() => {
    if ((nodeId || domainId) && sectionRef.current) {
      sectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [nodeId, domainId]);

  const domainDocs = useMemo(() => {
    if (!activeDomain) return [];
    return (edgesBySource.get(activeDomain.id) ?? [])
      .filter((e) => e.property === 'domainHasDoc')
      .map((e) => nodesById.get(e.target))
      .filter((n): n is GraphNode => !!n);
  }, [activeDomain, edgesBySource, nodesById]);

  if (sessionPending) return null;
  if (!session?.user) {
    return (
      <div className="bg-background text-foreground flex min-h-screen flex-col">
        <Header />
        <main className="flex-1 px-4 py-8">
          <div className="border-border bg-card mx-auto max-w-lg rounded-2xl border p-6 text-center">
            <h1 className="font-medium">
              {m['ai_assistant.login_required_title']()}
            </h1>
            <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
              {m['ai_assistant.login_required_description']()}
            </p>
            <Link
              href="/sign-in"
              className={cn(buttonVariants(), 'mt-5 rounded-full px-6')}
            >
              {m['ai_assistant.sign_in']()}
            </Link>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <Header />
      <main className="flex-1 px-4 py-8">
        <div className="mx-auto max-w-6xl">
          <h1 className="font-serif text-3xl font-normal tracking-tight sm:text-4xl">
            {m['graph.title']()}
          </h1>
          <p className="text-muted-foreground mt-3 max-w-2xl text-sm leading-relaxed">
            {m['graph.description']()}
          </p>
          <p className="text-muted-foreground mt-2 text-xs">
            {m['graph.data_as_of']({ date: GRAPH.generatedAt.slice(0, 10) })}
            {' · '}
            {m['graph.tree_version']({ version: GRAPH.treeVersion })}
            {' · '}
            {m['graph.counts_line']({
              domains: String(GRAPH.counts.domains ?? 0),
              nodes: String(GRAPH.counts.knowledgeNodes ?? 0),
              courses: String(liveCounts.linkedCourses),
            })}
            {liveCounts.publishedCourses !== null && (
              <>
                {' · '}
                {m['graph.published_total']({
                  n: String(liveCounts.publishedCourses),
                })}
              </>
            )}
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            {(
              [
                ['domain', 'graph.axis_domain'],
                ['stage', 'graph.axis_stage'],
                ['people', 'graph.axis_people'],
              ] as [Axis, string][]
            )
              .filter(([a]) => a !== 'people' || !!peopleQ.data)
              .map(([a, labelKey]) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => {
                    setAxis(a);
                    setNodeId(null);
                  }}
                  className={cn(
                    'rounded-full border px-4 py-1.5 text-sm',
                    axis === a
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-muted-foreground hover:text-primary'
                  )}
                >
                  {m[labelKey]()}
                </button>
              ))}
            {axis === 'domain' && (
              <span className="border-border ml-2 flex overflow-hidden rounded-full border text-sm">
                {(
                  [
                    ['list', 'graph.view_list'],
                    ['visual', 'graph.view_visual'],
                  ] as [ViewMode, string][]
                ).map(([v, labelKey]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      setViewMode(v);
                      try {
                        localStorage.setItem('graph-view-mode', v);
                      } catch {
                        /* 忽略 */
                      }
                    }}
                    className={cn(
                      'px-3 py-1.5',
                      viewMode === v
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-primary'
                    )}
                  >
                    {m[labelKey]()}
                  </button>
                ))}
              </span>
            )}
          </div>

          {axis === 'domain' && (
            <>
              <div className="mt-6 flex flex-wrap gap-2">
                {ROLES.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => {
                      setRole(r.key);
                      setDomainId(null);
                      setNodeId(null);
                    }}
                    className={cn(
                      'rounded-full border px-4 py-1.5 text-sm',
                      role === r.key
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-muted-foreground hover:text-primary'
                    )}
                  >
                    {m[r.labelKey]()}
                  </button>
                ))}
              </div>
              {role === 'service' && (
                <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
                  {m['graph.role_service_note']()}
                </p>
              )}
            </>
          )}

          {axis === 'domain' && viewMode === 'visual' ? (
            <div className="mt-6 space-y-6">
              <VisualGraph
                items={visualData.items}
                links={visualData.links}
                selectedId={nodeId}
                onSelect={(id) => {
                  if (id.startsWith('node:')) setNodeId(id);
                  else if (id.startsWith('course:')) {
                    const c = liveCourseByBid.get(id.slice('course:'.length));
                    if (c) window.open(`/blog/${c.slug}`, '_blank');
                  } else if (id.startsWith('domain:')) {
                    setDomainId(id);
                    setNodeId(null);
                    setViewMode('list');
                    try {
                      localStorage.setItem('graph-view-mode', 'list');
                    } catch {
                      /* 忽略 */
                    }
                  }
                }}
              />
              {selectedNode && (
                <section ref={sectionRef} className="scroll-mt-20">
                  <NodeDetail
                    node={selectedNode}
                    courses={nodeEdges.courses}
                    docs={nodeEdges.docs}
                    related={nodeEdges.related}
                    liveCourseStatus={liveCourseStatus}
                    liveDocKeys={liveDocKeys}
                    onBack={() => setNodeId(null)}
                    onSelectNode={(id) => setNodeId(id)}
                  />
                </section>
              )}
            </div>
          ) : axis === 'domain' ? (
            <div className="mt-6 grid gap-6 lg:grid-cols-[280px_1fr]">
              <aside className="space-y-2">
                {visibleDomains.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => {
                      setDomainId(d.id);
                      setNodeId(null);
                    }}
                    className={cn(
                      'block w-full rounded-xl border px-4 py-3 text-left',
                      activeDomain?.id === d.id
                        ? 'border-primary bg-card'
                        : 'border-border bg-card hover:border-foreground/20'
                    )}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      <span
                        className="size-3 shrink-0 rounded-full"
                        style={{ backgroundColor: d.data.color || '#6b7280' }}
                      />
                      {d.label}
                    </span>
                    <span className="text-muted-foreground mt-1 block text-xs">
                      {m['graph.domain_node_count']({
                        n: String(
                          (edgesBySource.get(d.id) ?? []).filter(
                            (e) =>
                              e.property === 'domainHasNode' &&
                              visibleNodeIds.has(e.target)
                          ).length
                        ),
                      })}
                    </span>
                  </button>
                ))}
              </aside>

              <section ref={sectionRef} className="scroll-mt-20">
                {!selectedNode ? (
                  <div className="space-y-3">
                    <h2 className="text-lg font-medium">
                      {activeDomain?.label ?? ''}
                    </h2>
                    {activeDomain?.data.description && (
                      <p className="text-muted-foreground text-sm leading-relaxed">
                        {activeDomain.data.description}
                      </p>
                    )}
                    {domainDocs.length > 0 && (
                      <div className="space-y-2">
                        <h3 className="text-sm font-medium">
                          {m['graph.docs']()}
                        </h3>
                        {domainDocs.map((doc) => (
                          <DocRow key={doc.id} doc={doc} live={liveDocKeys} />
                        ))}
                      </div>
                    )}
                    <div className="grid gap-3 sm:grid-cols-2">
                      {domainNodes.map((n) => (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => setNodeId(n.id)}
                          className="border-border bg-card hover:border-foreground/20 block rounded-2xl border p-4 text-left"
                        >
                          <span className="font-medium">{n.label}</span>
                          <span className="text-muted-foreground mt-1 block text-xs">
                            {m['graph.node_meta']({
                              difficulty: String(n.data.difficulty ?? '-'),
                              hours: String(n.data.estimatedHours ?? '-'),
                            })}
                          </span>
                          {(n.data.keyTopics ?? []).length > 0 && (
                            <span className="text-muted-foreground mt-2 block text-xs leading-relaxed">
                              {(n.data.keyTopics ?? []).slice(0, 3).join(' · ')}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                    {domainNodes.length === 0 && (
                      <p className="text-muted-foreground text-sm">
                        {m['graph.no_nodes']()}
                      </p>
                    )}
                  </div>
                ) : (
                  <NodeDetail
                    node={selectedNode}
                    courses={nodeEdges.courses}
                    docs={nodeEdges.docs}
                    related={nodeEdges.related}
                    liveCourseStatus={liveCourseStatus}
                    liveDocKeys={liveDocKeys}
                    onBack={() => setNodeId(null)}
                    onSelectNode={(id) => setNodeId(id)}
                  />
                )}
              </section>
            </div>
          ) : axis === 'stage' ? (
            <StageView
              pathKey={pathKey}
              onPathKey={setPathKey}
              nodesById={nodesById}
              nodeCourseCount={nodeCourseCount}
              onSelectNode={(id) => {
                setAxis('domain');
                setNodeId(id);
              }}
            />
          ) : (
            <PeopleView
              data={peopleQ.data ?? null}
              isPending={peopleQ.isPending}
              mentorId={mentorId}
              onMentorId={setMentorId}
            />
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}

function DocRow({ doc, live }: { doc: GraphNode; live: Set<string> }) {
  const key = `${doc.data.docKey}#${doc.data.sectionId}`;
  const isLive = live.size === 0 ? true : live.has(key);
  // 文档链接不直接用 graph.json 里的静态 url（它曾被写成 /html/html/…
  // 的双前缀坏链）：按 blogHtmlUrl 的同一口径现算——/api/blog/html/
  // + 编码后的 key + #sectionId，再经 withAppBase 补 /wiki 前缀。
  const href =
    doc.data.docKey && doc.data.sectionId
      ? `${withAppBase(`/api/blog/html/${encodeURIComponent(doc.data.docKey)}`)}#${doc.data.sectionId}`
      : doc.data.url || '#';
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="border-border flex items-center justify-between gap-2 rounded-xl border px-4 py-3 text-sm"
    >
      <span>
        <span className="text-muted-foreground block text-xs">
          {doc.data.docTitle}
        </span>
        <span className="font-medium">{doc.label}</span>
      </span>
      <span className="text-primary shrink-0 font-medium">
        {isLive ? m['graph.open_doc']() : m['graph.doc_updated']()} ↗
      </span>
    </a>
  );
}

function NodeDetail({
  node,
  courses,
  docs,
  related,
  liveCourseStatus,
  liveDocKeys,
  onBack,
  onSelectNode,
}: {
  node: GraphNode;
  courses: GraphNode[];
  docs: GraphNode[];
  related: { label: string; node: GraphNode; prop: string }[];
  liveCourseStatus: Map<string, string>;
  liveDocKeys: Set<string>;
  onBack: () => void;
  onSelectNode: (id: string) => void;
}) {
  const d = node.data;
  const askHref = `/ai-assistant?q=${encodeURIComponent(
    m['graph.ask_template']({ node: node.label })
  )}`;
  const relLabel: Record<string, string> = {
    nodePrerequisite: m['graph.rel_prerequisite'](),
    nodeExtends: m['graph.rel_extends'](),
    nodeParallel: m['graph.rel_parallel'](),
  };
  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={onBack}
        className="text-muted-foreground hover:text-primary text-sm"
      >
        ← {m['graph.back_to_domain']()}
      </button>
      <div>
        <h2 className="text-xl font-medium">{node.label}</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          {m['graph.node_meta']({
            difficulty: String(d.difficulty ?? '-'),
            hours: String(d.estimatedHours ?? '-'),
          })}
        </p>
      </div>
      {(d.keyTopics ?? []).length > 0 && (
        <section>
          <h3 className="text-sm font-medium">{m['graph.key_topics']()}</h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(d.keyTopics ?? []).map((t) => (
              <span
                key={t}
                className="bg-muted rounded-full px-2.5 py-1 text-xs"
              >
                {t}
              </span>
            ))}
          </div>
        </section>
      )}
      {d.salesKpi && (
        <p className="border-border bg-card rounded-xl border px-4 py-3 text-sm leading-relaxed">
          {m['graph.sales_kpi']()}：{d.salesKpi}
        </p>
      )}
      {(d.instruments ?? []).length > 0 && (
        <p className="text-muted-foreground text-sm leading-relaxed">
          {m['graph.instruments']()}：{(d.instruments ?? []).join('、')}
        </p>
      )}
      {(d.parameters ?? []).length > 0 && (
        <p className="text-muted-foreground text-sm leading-relaxed">
          {m['graph.parameters']()}：{(d.parameters ?? []).join('、')}
        </p>
      )}
      <section>
        <h3 className="text-sm font-medium">{m['graph.courses']()}</h3>
        {courses.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">
            {m['graph.no_courses']()}
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {courses.map((c) => {
              const live = c.data.shifuBid
                ? liveCourseStatus.get(c.data.shifuBid)
                : undefined;
              const published = (live ?? c.data.status) === 'published';
              return (
                <div
                  key={c.id}
                  className="border-border flex items-center justify-between gap-2 rounded-xl border px-4 py-3 text-sm"
                >
                  <span className="font-medium">{c.label}</span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="text-muted-foreground text-xs">
                      {statusText(c.data.status, live)}
                    </span>
                    {published && c.data.slug && (
                      <Link
                        href={`/blog/${c.data.slug}`}
                        className="text-primary font-medium"
                      >
                        {m['graph.open_course']()} ↗
                      </Link>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
      {docs.length > 0 && (
        <section>
          <h3 className="text-sm font-medium">{m['graph.docs']()}</h3>
          <div className="mt-2 space-y-2">
            {docs.map((doc) => (
              <DocRow key={doc.id} doc={doc} live={liveDocKeys} />
            ))}
          </div>
        </section>
      )}
      {related.length > 0 && (
        <section>
          <h3 className="text-sm font-medium">{m['graph.related']()}</h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {related.map((r) => (
              <button
                key={`${r.prop}:${r.node.id}`}
                type="button"
                onClick={() => onSelectNode(r.node.id)}
                className="border-border hover:border-foreground/20 rounded-full border px-3 py-1 text-xs"
              >
                {relLabel[r.prop] ?? r.prop} · {r.node.label}
              </button>
            ))}
          </div>
        </section>
      )}
      <div>
        <Link
          href={askHref}
          className={cn(buttonVariants(), 'rounded-full px-6')}
        >
          {m['graph.ask_assistant']()}
        </Link>
      </div>
    </div>
  );
}

function StageView({
  pathKey,
  onPathKey,
  nodesById,
  nodeCourseCount,
  onSelectNode,
}: {
  pathKey: PathKey;
  onPathKey: (k: PathKey) => void;
  nodesById: Map<string, GraphNode>;
  nodeCourseCount: Map<string, number>;
  onSelectNode: (id: string) => void;
}) {
  const path = TREE.learning_paths_detail[pathKey];
  if (!path) return null;
  const stages = [...path.stages].sort((a, b) => a.stage - b.stage);
  let skipped = 0;
  return (
    <div className="mt-6 space-y-6">
      <div className="flex flex-wrap gap-2">
        {PATH_KEYS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onPathKey(k)}
            className={cn(
              'rounded-full border px-4 py-1.5 text-sm',
              pathKey === k
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:text-primary'
            )}
          >
            {m[PATH_LABEL[k]]()}
          </button>
        ))}
      </div>
      <div>
        <h2 className="text-lg font-medium">{path.name}</h2>
        <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
          {path.intro}
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          {m['graph.stage_total_credits']({
            n: String(path.total_credits),
          })}
        </p>
      </div>
      {stages.map((st) => {
        const nodes = st.nodes
          .map((slug) => nodesById.get(`node:${slug}`))
          .filter((n): n is GraphNode => {
            if (!n) skipped += 1;
            return !!n;
          });
        return (
          <section key={st.stage} className="space-y-3">
            <div>
              <h3 className="font-medium">
                {m['graph.stage_label']({ n: String(st.stage) })} · {st.name}
              </h3>
              <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
                {st.desc}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {nodes.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onSelectNode(n.id)}
                  className="border-border bg-card hover:border-foreground/20 block rounded-2xl border p-4 text-left"
                >
                  <span className="font-medium">{n.label}</span>
                  <span className="text-muted-foreground mt-1 block text-xs">
                    {m['graph.node_meta']({
                      difficulty: String(n.data.difficulty ?? '-'),
                      hours: String(n.data.estimatedHours ?? '-'),
                    })}
                    {' · '}
                    {m['graph.stage_node_courses']({
                      n: String(nodeCourseCount.get(n.id) ?? 0),
                    })}
                  </span>
                </button>
              ))}
            </div>
            {nodes.length === 0 && (
              <p className="text-muted-foreground text-sm">
                {m['graph.no_nodes']()}
              </p>
            )}
          </section>
        );
      })}
      {skipped > 0 && (
        <p className="text-muted-foreground text-xs">
          {m['graph.stage_skipped_nodes']({ n: String(skipped) })}
        </p>
      )}
    </div>
  );
}

const FLAG_LABEL: Record<string, string> = {
  overdue: 'graph.flag_overdue',
  pending_confirm: 'graph.flag_pending_confirm',
  no_course_activity: 'graph.flag_no_course_activity',
  no_wiki_account: 'graph.flag_no_wiki_account',
  unresolved_identity: 'graph.flag_unresolved_identity',
};

const RECOMMEND_LABEL: Record<string, string> = {
  no_record: 'graph.recommend_no_record',
  pending_confirm: 'graph.recommend_pending_confirm',
  no_course_activity: 'graph.recommend_no_course_activity',
  next_stage: 'graph.recommend_next_stage',
  all_done: 'graph.recommend_all_done',
};

function PeopleView({
  data,
  isPending,
  mentorId,
  onMentorId,
}: {
  data: PeopleData | null;
  isPending: boolean;
  mentorId: string | null;
  onMentorId: (id: string | null) => void;
}) {
  if (isPending) {
    return (
      <p className="text-muted-foreground mt-6 text-sm">
        {m['graph.people_loading']()}
      </p>
    );
  }
  if (!data) {
    return (
      <p className="text-muted-foreground mt-6 text-sm">
        {m['graph.people_unavailable']()}
      </p>
    );
  }
  const activeMentor =
    data.scope === 'admin'
      ? (data.mentors.find((x) => x.id === mentorId) ?? data.mentors[0])
      : data.mentors[0];
  return (
    <div className="mt-6 space-y-6">
      <p className="text-muted-foreground text-sm leading-relaxed">
        {data.scope === 'admin'
          ? m['graph.people_admin_note']()
          : m['graph.people_mentor_note']()}
      </p>
      {data.scope === 'admin' && data.mentors.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {data.mentors.map((x) => (
            <button
              key={x.id}
              type="button"
              onClick={() => onMentorId(x.id)}
              className={cn(
                'rounded-full border px-4 py-1.5 text-sm',
                activeMentor?.id === x.id
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:text-primary'
              )}
            >
              {x.name}（{x.mentees.length}）
            </button>
          ))}
        </div>
      )}
      {activeMentor && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">
            {activeMentor.name}
            {activeMentor.mentorTypes.length > 0 && (
              <span className="text-muted-foreground ml-2 text-sm font-normal">
                {activeMentor.mentorTypes.join('、')}
              </span>
            )}
          </h2>
          {activeMentor.mentees.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {m['graph.people_no_mentees']()}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {activeMentor.mentees.map((person) => (
                <div
                  key={`${person.name}-${person.employeeNo ?? ''}`}
                  className="border-border bg-card rounded-2xl border p-4"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{person.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {person.employeeNo ?? ''}
                      {person.planType ? ` · ${person.planType}` : ''}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {person.status
                      ? m['graph.people_status']({ s: person.status })
                      : m['graph.people_no_status']()}
                    {person.coursesTaken > 0 &&
                      ` · ${m['graph.people_courses_taken']({
                        n: String(person.coursesTaken),
                      })}`}
                  </p>
                  {person.flags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {person.flags.map((f) => (
                        <span
                          key={f}
                          className="rounded-full bg-amber-500/10 px-2.5 py-1 text-xs text-amber-600"
                        >
                          {m[FLAG_LABEL[f] ?? 'graph.flag_unknown']()}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="mt-3 text-sm leading-relaxed">
                    {m[
                      RECOMMEND_LABEL[person.recommendReason] ??
                        'graph.recommend_no_record'
                    ]()}
                  </p>
                  {person.recommendation && (
                    <Link
                      href={`/blog/${person.recommendation.slug}`}
                      className="text-primary mt-1 block text-sm font-medium"
                    >
                      {person.recommendation.title} ↗
                    </Link>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
