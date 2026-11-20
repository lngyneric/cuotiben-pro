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
import growthData from '@/content/growth/growth.json';

import {
  VisualGraph,
  type VisualItem,
  type VisualLink,
} from './graph/-visual-graph';

interface GrowthCourse {
  shifu_bid: string;
  title: string;
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

interface GrowthNode {
  id: string;
  domain: string;
  name: string;
  difficulty: number;
  estimated_hours: number;
  phase: string;
  skills: string[];
  sysmex_relevance: string;
  prerequisites: string[];
  extends: string[];
  parallel: string[];
  courses: GrowthCourse[];
}

interface GrowthDomain {
  id: string;
  name: string;
  color: string;
  description: string;
}

interface GrowthFile {
  subject: string;
  name: string;
  description: string;
  version: string;
  source: string;
  target_roles: string[];
  domains: GrowthDomain[];
  nodes: GrowthNode[];
  counts: {
    nodes: number;
    domains: number;
    courses: number;
    gaps: number;
  };
}

const GROWTH = growthData as unknown as GrowthFile;

type ViewMode = 'list' | 'visual';

/**
 * 学习计划：按先修关系拓扑排序。反复取“先修已全部在计划里”的节点，
 * 同批按难度升序；有环时剩余节点按难度追加，绝不丢节点。
 */
function planOrder(nodes: GrowthNode[]): GrowthNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const done = new Set<string>();
  const out: GrowthNode[] = [];
  const rest = [...nodes];
  while (rest.length > 0) {
    const ready = rest.filter((n) =>
      n.prerequisites.every((p) => !byId.has(p) || done.has(p))
    );
    if (ready.length === 0) break;
    ready.sort(
      (a, b) =>
        a.difficulty - b.difficulty || a.name.localeCompare(b.name, 'zh')
    );
    const pick = ready[0];
    out.push(pick);
    done.add(pick.id);
    rest.splice(rest.indexOf(pick), 1);
  }
  rest.sort(
    (a, b) => a.difficulty - b.difficulty || a.name.localeCompare(b.name, 'zh')
  );
  return [...out, ...rest];
}

export const Route = createFileRoute('/growth')({
  loader: async () => {
    const locale = getLocale();
    return { locale };
  },
  head: ({ loaderData }) => {
    const locale = loaderData?.locale ?? 'zh';
    const urlFor = (loc: string) => localizedAbsoluteUrl('/growth', loc);
    return {
      meta: [
        {
          title: `${m['growth.title']({}, { locale: locale as any })} | ${envConfigs.app_name}`,
        },
        {
          name: 'description',
          content: m['growth.description']({}, { locale: locale as any }),
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
  component: GrowthPage,
});

function GrowthPage() {
  const { data: session, isPending: sessionPending } = useSession();
  const [domainId, setDomainId] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [gapsOnly, setGapsOnly] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      return (
        (localStorage.getItem('growth-view-mode') as ViewMode | null) || 'list'
      );
    } catch {
      return 'list';
    }
  });
  const sectionRef = useRef<HTMLElement>(null);

  const nodesById = useMemo(
    () => new Map(GROWTH.nodes.map((n) => [n.id, n])),
    []
  );
  const domainsById = useMemo(
    () => new Map(GROWTH.domains.map((d) => [d.id, d])),
    []
  );

  // 实时叠加：定时同步按标题匹配到的视频课；失败时用静态状态降级展示。
  const overlayQ = useQuery({
    queryKey: ['growth-overlay'],
    queryFn: () =>
      apiGet<{
        courses: OverlayCourse[];
        links: OverlayLink[];
      }>('/api/growth'),
    staleTime: 60_000,
    retry: false,
  });
  const liveCourseByBid = useMemo(() => {
    const map = new Map<string, OverlayCourse>();
    for (const c of overlayQ.data?.courses ?? []) map.set(c.bid, c);
    return map;
  }, [overlayQ.data]);
  // 节点 → 自动匹配到的视频课（只保留已发布且在 blog 里有记录的）。
  const matchedByNode = useMemo(() => {
    const map = new Map<string, OverlayCourse[]>();
    for (const l of overlayQ.data?.links ?? []) {
      const c = liveCourseByBid.get(l.courseBid);
      if (!c || c.status !== 'published') continue;
      const list = map.get(l.nodeId) ?? [];
      list.push(c);
      map.set(l.nodeId, list);
    }
    return map;
  }, [overlayQ.data, liveCourseByBid]);
  // 节点是否有课：静态 ai-shifu 课程或自动匹配到的视频课，任一即可。
  const hasCourse = (n: GrowthNode) =>
    n.courses.length > 0 || (matchedByNode.get(n.id)?.length ?? 0) > 0;
  // 实时计数：静态 8 门＋自动匹配到的视频课；缺口随之减少。
  const liveCounts = useMemo(() => {
    const withCourse = GROWTH.nodes.filter((n) => hasCourse(n)).length;
    const matchedLinks = [...matchedByNode.values()].reduce(
      (s, list) => s + list.length,
      0
    );
    return {
      courses: GROWTH.counts.courses + matchedLinks,
      gaps: GROWTH.counts.nodes - withCourse,
    };
  }, [matchedByNode]);

  const visibleNodes = useMemo(() => {
    return GROWTH.nodes.filter((n) => {
      if (domainId && n.domain !== domainId) return false;
      if (gapsOnly && hasCourse(n)) return false;
      return true;
    });
  }, [domainId, gapsOnly, matchedByNode]);

  const visibleIds = useMemo(
    () => new Set(visibleNodes.map((n) => n.id)),
    [visibleNodes]
  );

  const activeDomain = domainId ? domainsById.get(domainId) : undefined;
  const selectedNode = nodeId ? nodesById.get(nodeId) : undefined;

  // 可视化数据：领域（大）＋能力节点（中）；边：领域—节点／先修／进阶／并行。
  const visualData = useMemo(() => {
    const items: VisualItem[] = [];
    const links: VisualLink[] = [];
    const domains = domainId
      ? GROWTH.domains.filter((d) => d.id === domainId)
      : GROWTH.domains;
    for (const d of domains) {
      items.push({
        id: `domain:${d.id}`,
        label: d.name,
        kind: 'domain',
        color: d.color,
      });
    }
    for (const n of visibleNodes) {
      const d = domainsById.get(n.domain);
      items.push({
        id: `node:${n.id}`,
        label: n.name,
        kind: 'node',
        color: d?.color ?? '#64748b',
        status: hasCourse(n) ? 'has-course' : 'gap',
      });
      links.push({
        source: `domain:${n.domain}`,
        target: `node:${n.id}`,
        kind: 'domain',
      });
      for (const p of n.prerequisites) {
        if (visibleIds.has(p))
          links.push({
            source: `node:${p}`,
            target: `node:${n.id}`,
            kind: 'rel',
          });
      }
      for (const e of n.extends) {
        if (visibleIds.has(e))
          links.push({
            source: `node:${n.id}`,
            target: `node:${e}`,
            kind: 'rel',
          });
      }
      for (const p of n.parallel) {
        if (visibleIds.has(p) && n.id < p)
          links.push({
            source: `node:${n.id}`,
            target: `node:${p}`,
            kind: 'rel',
          });
      }
    }
    return { items, links };
  }, [visibleNodes, visibleIds, domainId, domainsById]);

  // 学习计划：可见节点按先修关系排好的顺序。
  const plan = useMemo(() => planOrder(visibleNodes), [visibleNodes]);
  const planHours = useMemo(
    () => plan.reduce((s, n) => s + (n.estimated_hours || 0), 0),
    [plan]
  );

  // 选节点后滚到详情顶部（section 带 scroll-mt，标题不被置顶导航栏遮住）。
  useEffect(() => {
    if ((nodeId || domainId) && sectionRef.current) {
      sectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [nodeId, domainId]);

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
            {m['growth.title']()}
          </h1>
          <p className="text-muted-foreground mt-3 max-w-2xl text-sm leading-relaxed">
            {m['growth.description']()}
          </p>
          <p className="text-muted-foreground mt-2 text-xs">
            {m['growth.counts_line']({
              domains: String(GROWTH.counts.domains),
              nodes: String(GROWTH.counts.nodes),
              courses: String(liveCounts.courses),
              gaps: String(liveCounts.gaps),
            })}
            {' · '}
            {m['growth.version']({ version: GROWTH.version })}
          </p>

          <p className="text-muted-foreground mt-4 text-sm leading-relaxed">
            {m['growth.to_graph_prefix']()}{' '}
            <Link
              href="/graph"
              className="text-primary font-medium underline underline-offset-4"
            >
              {m['growth.to_graph_link']()}
            </Link>
            {m['growth.to_graph_suffix']()}
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setDomainId(null);
                setNodeId(null);
              }}
              className={cn(
                'rounded-full border px-4 py-1.5 text-sm',
                domainId === null
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:text-primary'
              )}
            >
              {m['growth.domain_all']()}
            </button>
            {GROWTH.domains.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => {
                  setDomainId(d.id);
                  setNodeId(null);
                }}
                className={cn(
                  'rounded-full border px-4 py-1.5 text-sm',
                  domainId === d.id
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:text-primary'
                )}
              >
                {d.name}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setGapsOnly((v) => !v)}
              className={cn(
                'rounded-full border px-4 py-1.5 text-sm',
                gapsOnly
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:text-primary'
              )}
            >
              {m['growth.filter_gaps_only']()}
            </button>
            <span className="border-border ml-2 flex overflow-hidden rounded-full border text-sm">
              {(
                [
                  ['list', 'growth.view_list'],
                  ['visual', 'growth.view_visual'],
                ] as [ViewMode, string][]
              ).map(([v, labelKey]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => {
                    setViewMode(v);
                    try {
                      localStorage.setItem('growth-view-mode', v);
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
          </div>

          {viewMode === 'visual' ? (
            <div className="mt-6 space-y-6">
              <VisualGraph
                items={visualData.items}
                links={visualData.links}
                selectedId={nodeId ? `node:${nodeId}` : null}
                onSelect={(id) => {
                  if (id.startsWith('node:'))
                    setNodeId(id.slice('node:'.length));
                  else if (id.startsWith('domain:')) {
                    setDomainId(id.slice('domain:'.length));
                    setNodeId(null);
                    setViewMode('list');
                    try {
                      localStorage.setItem('growth-view-mode', 'list');
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
                    domain={domainsById.get(selectedNode.domain)}
                    matched={matchedByNode.get(selectedNode.id) ?? []}
                    hasCourse={hasCourse(selectedNode)}
                    onBack={() => setNodeId(null)}
                    onSelectNode={(id) => setNodeId(id)}
                  />
                </section>
              )}
            </div>
          ) : (
            <div className="mt-6 grid gap-6 lg:grid-cols-[280px_1fr]">
              <aside className="space-y-2">
                {GROWTH.domains.map((d) => {
                  const count = GROWTH.nodes.filter(
                    (n) => n.domain === d.id
                  ).length;
                  const gapCount = GROWTH.nodes.filter(
                    (n) => n.domain === d.id && !hasCourse(n)
                  ).length;
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => {
                        setDomainId(domainId === d.id ? null : d.id);
                        setNodeId(null);
                      }}
                      className={cn(
                        'border-border block w-full rounded-xl border px-4 py-3 text-left',
                        domainId === d.id
                          ? 'border-primary bg-primary/5'
                          : 'hover:border-primary/50'
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block h-3 w-3 shrink-0 rounded-full"
                          style={{ backgroundColor: d.color }}
                        />
                        <span className="font-medium">{d.name}</span>
                      </span>
                      <span className="text-muted-foreground mt-1 block text-xs">
                        {m['growth.domain_node_count']({
                          n: String(count),
                          gaps: String(gapCount),
                        })}
                      </span>
                    </button>
                  );
                })}
              </aside>
              <div className="space-y-6">
                {selectedNode ? (
                  <section ref={sectionRef} className="scroll-mt-20">
                    <NodeDetail
                      node={selectedNode}
                      domain={domainsById.get(selectedNode.domain)}
                      matched={matchedByNode.get(selectedNode.id) ?? []}
                      hasCourse={hasCourse(selectedNode)}
                      onBack={() => setNodeId(null)}
                      onSelectNode={(id) => setNodeId(id)}
                    />
                  </section>
                ) : (
                  <div className="space-y-3">
                    {activeDomain && (
                      <p className="text-muted-foreground text-sm leading-relaxed">
                        {activeDomain.description}
                      </p>
                    )}
                    {visibleNodes.length === 0 ? (
                      <p className="text-muted-foreground text-sm">
                        {m['growth.no_nodes']()}
                      </p>
                    ) : (
                      visibleNodes.map((n) => (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => setNodeId(n.id)}
                          className="border-border hover:border-primary/50 block w-full rounded-xl border px-4 py-3 text-left"
                        >
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{n.name}</span>
                            {n.phase && (
                              <span className="bg-secondary text-secondary-foreground rounded-full px-2 py-0.5 text-xs">
                                {n.phase}
                              </span>
                            )}
                            {hasCourse(n) ? (
                              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">
                                {m['growth.has_course']()}
                              </span>
                            ) : (
                              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400">
                                {m['growth.no_course']()}
                              </span>
                            )}
                          </span>
                          <span className="text-muted-foreground mt-1 block text-xs">
                            {m['growth.node_meta']({
                              difficulty: String(n.difficulty),
                              hours: String(n.estimated_hours),
                            })}
                            {' · '}
                            {domainsById.get(n.domain)?.name ?? ''}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          <section className="mt-10">
            <h2 className="font-serif text-xl font-normal tracking-tight">
              {m['growth.plan_title']()}
            </h2>
            <p className="text-muted-foreground mt-2 max-w-2xl text-sm leading-relaxed">
              {m['growth.plan_description']()}
            </p>
            <p className="text-muted-foreground mt-2 text-xs">
              {m['growth.plan_total']({
                n: String(plan.length),
                hours: String(planHours),
              })}
            </p>
            {plan.length === 0 ? (
              <p className="text-muted-foreground mt-4 text-sm">
                {m['growth.no_nodes']()}
              </p>
            ) : (
              <ol className="mt-4 space-y-2">
                {plan.map((n, i) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => setNodeId(n.id)}
                      className="border-border hover:border-primary/50 flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left"
                    >
                      <span className="bg-primary text-primary-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {n.name}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {domainsById.get(n.domain)?.name ?? ''}
                          {' · '}
                          {m['growth.node_meta']({
                            difficulty: String(n.difficulty),
                            hours: String(n.estimated_hours),
                          })}
                        </span>
                      </span>
                      {hasCourse(n) ? (
                        <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">
                          {m['growth.has_course']()}
                        </span>
                      ) : (
                        <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400">
                          {m['growth.no_course']()}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function NodeDetail({
  node,
  domain,
  matched,
  hasCourse,
  onBack,
  onSelectNode,
}: {
  node: GrowthNode;
  domain: GrowthDomain | undefined;
  matched: OverlayCourse[];
  hasCourse: boolean;
  onBack: () => void;
  onSelectNode: (id: string) => void;
}) {
  const nodesById = useMemo(
    () => new Map(GROWTH.nodes.map((n) => [n.id, n])),
    []
  );
  const rel = (ids: string[]) =>
    ids.map((id) => nodesById.get(id)).filter((n): n is GrowthNode => !!n);

  return (
    <article className="border-border bg-card rounded-2xl border p-6">
      <button
        type="button"
        onClick={onBack}
        className="text-muted-foreground hover:text-primary text-sm"
      >
        ← {m['growth.back_to_list']()}
      </button>
      <h2 className="mt-3 font-serif text-2xl font-normal tracking-tight">
        {node.name}
      </h2>
      <p className="text-muted-foreground mt-2 text-sm">
        {domain?.name ?? ''}
        {node.phase ? ` · ${node.phase}` : ''}
        {' · '}
        {m['growth.node_meta']({
          difficulty: String(node.difficulty),
          hours: String(node.estimated_hours),
        })}
      </p>
      {hasCourse ? (
        <span className="mt-3 inline-block rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">
          {m['growth.has_course']()}
        </span>
      ) : (
        <span className="mt-3 inline-block rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400">
          {m['growth.no_course']()}
        </span>
      )}

      {node.skills.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-medium">{m['growth.skills']()}</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {node.skills.map((s) => (
              <span
                key={s}
                className="bg-secondary text-secondary-foreground rounded-full px-2.5 py-1 text-xs"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5 space-y-4">
        {(
          [
            ['prerequisites', node.prerequisites],
            ['extends', node.extends],
            ['parallel', node.parallel],
          ] as const
        ).map(([key, ids]) => {
          const items = rel(ids);
          if (items.length === 0) return null;
          return (
            <div key={key}>
              <h3 className="text-sm font-medium">{m[`growth.${key}`]()}</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {items.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => onSelectNode(n.id)}
                    className="border-border hover:border-primary rounded-full border px-3 py-1 text-sm"
                  >
                    {n.name}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-medium">{m['growth.courses']()}</h3>
        {node.courses.length === 0 && matched.length === 0 ? (
          <p className="text-muted-foreground mt-2 text-sm">
            {m['growth.no_course_desc']()}
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {node.courses.map((c) => (
              <li key={c.shifu_bid}>
                <a
                  href={`/c/${c.shifu_bid}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary block truncate text-sm underline underline-offset-4"
                >
                  {c.title}
                </a>
              </li>
            ))}
            {matched.map((c) => (
              <li key={c.bid}>
                <Link
                  href={withAppBase(`/blog/${c.slug}`)}
                  className="text-primary block truncate text-sm underline underline-offset-4"
                >
                  {c.title}
                </Link>
                <span className="text-muted-foreground text-xs">
                  {m['growth.auto_matched']()}
                </span>
              </li>
            ))}
          </ul>
        )}
        {matched.length > 0 && (
          <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
            {m['growth.auto_matched_note']()}
          </p>
        )}
      </div>

      <div className="mt-6">
        <Link
          href={`/ai-assistant?q=${encodeURIComponent(node.name)}`}
          className={cn(buttonVariants({ variant: 'outline' }), 'rounded-full')}
        >
          {m['growth.ask_assistant']()}
        </Link>
      </div>
    </article>
  );
}
