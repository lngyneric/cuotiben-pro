import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

import { useSession } from '@/core/auth/client';
import { Link } from '@/core/i18n/navigation';
import { localizedAbsoluteUrl } from '@/core/i18n/urls';
import { envConfigs } from '@/config';
import { apiGet } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';
import { getLocale, locales } from '@/paraglide/runtime.js';
import { Footer } from '@/blocks/footer';
import { Header } from '@/blocks/header';
import { buttonVariants } from '@/components/ui/button';
import graphData from '@/content/graph/graph.json';

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

interface OverlayDoc {
  docKey: string;
  docTitle: string;
  sectionId: string;
  sectionTitle: string;
  url: string;
}

const GRAPH = graphData as unknown as GraphFile;

type Role = 'all' | 'sales' | 'application' | 'service';

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

  // 实时叠加：课程发布状态＋文档清单；失败时用构建时状态降级展示。
  const overlayQ = useQuery({
    queryKey: ['graph-overlay'],
    queryFn: () =>
      apiGet<{ courses: OverlayCourse[]; docs: OverlayDoc[] }>('/api/graph'),
    staleTime: 60_000,
    retry: false,
  });
  const liveCourseStatus = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of overlayQ.data?.courses ?? []) map.set(c.bid, c.status);
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
  }, [selectedNode, edgesBySource, nodesById]);

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
              courses: String(GRAPH.counts.courses ?? 0),
            })}
          </p>

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

            <section>
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
        </div>
      </main>
      <Footer />
    </div>
  );
}

function DocRow({ doc, live }: { doc: GraphNode; live: Set<string> }) {
  const key = `${doc.data.docKey}#${doc.data.sectionId}`;
  const isLive = live.size === 0 ? true : live.has(key);
  return (
    <a
      href={doc.data.url || '#'}
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
