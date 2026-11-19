import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { MDXProvider } from '@mdx-js/react';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';

import { Link } from '@/core/i18n/navigation';
import { localizedAbsoluteUrl } from '@/core/i18n/urls';
import { envConfigs } from '@/config';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';
import { getLocale, locales } from '@/paraglide/runtime.js';
import { Footer } from '@/blocks/footer';
import { Header } from '@/blocks/header';
import { BlogCard } from '@/components/blog-card';
import { MarkdownContent } from '@/components/markdown-content';
import { mdxComponents } from '@/components/mdx-components';
import { formatPostDate, loadLocalPost, type BlogPost } from '@/content/posts';
import { getBlogPostFn, getBlogPostsFn } from '@/content/posts/server';

export const Route = createFileRoute('/blog/')({
  loader: async () => {
    const locale = getLocale();
    const posts = await getBlogPostsFn({ data: { locale } });
    return { locale, posts };
  },
  head: ({ loaderData }) => {
    const locale = loaderData?.locale;
    const urlFor = (loc: string) => localizedAbsoluteUrl('/blog', loc);
    return {
      meta: [
        {
          title: `${m['blog.title']({}, { locale: locale as any })} | ${envConfigs.app_name}`,
        },
        {
          name: 'description',
          content: m['blog.description']({}, { locale: locale as any }),
        },
      ],
      links: [
        { rel: 'canonical', href: urlFor(locale ?? 'zh') },
        ...locales.map((loc) => ({
          rel: 'alternate',
          hrefLang: loc,
          href: urlFor(loc),
        })),
      ],
    };
  },
  component: BlogPage,
});

type ViewMode = 'grid' | 'split';

/** 分屏/卡片展示方式只存本机浏览器（刷新不丢；换设备不带走）。 */
const VIEW_MODE_KEY = 'blog-view-mode';

function BlogPage() {
  const { locale, posts } = Route.useLoaderData();
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>(
    m['blog.all_categories']()
  );
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [selectedIndex, setSelectedIndex] = useState(0);
  // 左栏树：全部是根目录，分类是子目录，文章是子目录里的文件。
  const [allExpanded, setAllExpanded] = useState(true);
  const [expandedCats, setExpandedCats] = useState<Set<string>>(() => {
    const firstCats = (posts[0]?.categories ?? []).length
      ? (posts[0].categories as string[])
      : ['未分类'];
    return new Set([firstCats[0]]);
  });

  // 刷新后恢复本机保存的展示方式（只在客户端跑，避免服务端渲染不一致）。
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(VIEW_MODE_KEY);
      if (stored === 'grid' || stored === 'split') setViewMode(stored);
    } catch {
      // 存储不可用时静默跳过，保持默认卡片模式。
    }
  }, []);

  const setViewModeAndPersist = (mode: ViewMode) => {
    setViewMode(mode);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      // 存储满或被禁时静默跳过，不影响切换。
    }
  };

  // 分类：数据库文章的 categories（逗号分隔）展开去重；无分类的文章归“未分类”。
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of posts) {
      const cats = (p.categories ?? []).length
        ? (p.categories as string[])
        : ['未分类'];
      for (const c of cats) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [
      { name: m['blog.all_categories'](), count: posts.length },
      ...Array.from(counts.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => ({ name, count })),
    ];
  }, [posts]);

  // 先按搜索过滤，再按分类分组（“全部”就是全部搜索结果）。
  const searchFiltered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return posts;
    return posts.filter(
      (p: BlogPost) =>
        p.title.toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q)
    );
  }, [posts, search]);

  const articlesByCategory = useMemo(() => {
    const map = new Map<string, BlogPost[]>();
    map.set(m['blog.all_categories'](), searchFiltered);
    for (const p of searchFiltered) {
      const cats = (p.categories ?? []).length
        ? (p.categories as string[])
        : ['未分类'];
      for (const c of cats) {
        const arr = map.get(c);
        if (arr) arr.push(p);
        else map.set(c, [p]);
      }
    }
    return map;
  }, [searchFiltered]);

  // 当前分类的文章（右栏内容与上一篇/下一篇都走它）。
  const filtered = useMemo(
    () => articlesByCategory.get(activeCategory) ?? [],
    [articlesByCategory, activeCategory]
  );

  // 改搜索时回到该分类的第一篇（换分类在 selectCategory/selectArticle 里处理）。
  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  const safeIndex = Math.min(selectedIndex, Math.max(filtered.length - 1, 0));
  const selected = filtered[safeIndex];

  // 保证当前文章所在的分类在左栏是展开的（换文章/换分类时自动展开；
  // 手动点箭头收起的不受影响，因为 selected 没变时这个 effect 不跑）。
  useEffect(() => {
    if (!selected) return;
    const cat = (selected.categories ?? []).length
      ? (selected.categories as string[])[0]
      : '未分类';
    setExpandedCats((prev) => {
      if (prev.has(cat)) return prev;
      const next = new Set(prev);
      next.add(cat);
      return next;
    });
  }, [selected]);

  const selectCategory = (catName: string) => {
    setActiveCategory(catName);
    setSelectedIndex(0);
  };

  const selectArticle = (catName: string, idx: number) => {
    setActiveCategory(catName);
    setSelectedIndex(idx);
  };

  const toggleCat = (catName: string) => {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(catName)) next.delete(catName);
      else next.add(catName);
      return next;
    });
  };

  const detailQuery = useQuery({
    queryKey: ['blog-post-detail', selected?.slug, locale],
    queryFn: () => getBlogPostFn({ data: { slug: selected!.slug, locale } }),
    enabled: viewMode === 'split' && !!selected,
  });

  const detail = detailQuery.data ?? null;
  const LocalContent =
    detail?.source === 'local'
      ? (loadLocalPost(detail.slug, locale)?.default ?? null)
      : null;

  const goPrev = () => setSelectedIndex((i) => Math.max(i - 1, 0));
  const goNext = () =>
    setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <Header />
      <main className="flex-1 px-4 py-8">
        <div className="mx-auto max-w-7xl">
          <div className="mb-6 text-center">
            <h1 className="font-serif text-3xl font-normal tracking-tight sm:text-4xl">
              {m['blog.title']()}
            </h1>
            <p className="text-muted-foreground mx-auto mt-3 max-w-lg text-sm">
              {m['blog.description']()}
            </p>
          </div>

          {/* 展示方式切换：卡片网格 / 分屏阅读 */}
          <div className="mb-4 flex justify-center">
            <div className="border-border bg-card inline-flex rounded-full border p-1">
              {(['grid', 'split'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewModeAndPersist(mode)}
                  className={cn(
                    'rounded-full px-4 py-1 text-xs font-medium',
                    viewMode === mode
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-primary'
                  )}
                >
                  {mode === 'grid'
                    ? m['blog.view_grid']()
                    : m['blog.view_split']()}
                </button>
              ))}
            </div>
          </div>

          {/* 搜索（两种模式共用） */}
          <div className="mx-auto mb-6 max-w-3xl">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={m['blog.search_placeholder']()}
              className="border-border bg-card w-full rounded-full border px-4 py-2 text-sm"
            />
            {viewMode === 'grid' && (
              <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                {categories.map((cat) => (
                  <button
                    key={cat.name}
                    onClick={() => selectCategory(cat.name)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-xs',
                      activeCategory === cat.name
                        ? 'border-primary text-primary font-medium'
                        : 'border-border text-muted-foreground'
                    )}
                  >
                    {cat.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {viewMode === 'grid' ? (
            filtered.length === 0 ? (
              <p className="text-muted-foreground py-16 text-center text-sm">
                {m['blog.no_posts']()}
              </p>
            ) : (
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((post: BlogPost) => (
                  <BlogCard
                    key={post.slug}
                    href={`/blog/${post.slug}`}
                    title={post.title}
                    description={post.description}
                    image={post.image}
                    date={formatPostDate(post.createdAt, locale)}
                    authorName={post.authorName}
                    authorImage={post.authorImage}
                  />
                ))}
              </div>
            )
          ) : (
            /* 分屏阅读：左栏分类导航，右栏文章全文 */
            <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
              {/* 左：分类树（全部是根目录，分类是子目录，文章是子目录里的文件） */}
              <div className="bg-card border-border max-h-[70vh] overflow-y-auto rounded-lg border p-4">
                <ul className="space-y-1">
                  <li>
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => setAllExpanded((v) => !v)}
                        aria-label={
                          allExpanded
                            ? m['blog.collapse']()
                            : m['blog.expand']()
                        }
                        className="text-muted-foreground hover:text-primary flex size-6 shrink-0 items-center justify-center rounded-md"
                      >
                        {allExpanded ? (
                          <ChevronDown className="size-4" />
                        ) : (
                          <ChevronRight className="size-4" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => selectCategory(categories[0].name)}
                        className={cn(
                          'flex flex-1 items-center justify-between rounded-lg px-3 py-2 text-left text-sm',
                          activeCategory === categories[0].name
                            ? 'bg-primary text-primary-foreground font-medium'
                            : 'text-foreground hover:bg-muted'
                        )}
                      >
                        <span className="truncate">{categories[0].name}</span>
                        <span
                          className={cn(
                            'ml-2 shrink-0 text-xs',
                            activeCategory === categories[0].name
                              ? 'text-primary-foreground/80'
                              : 'text-muted-foreground'
                          )}
                        >
                          {categories[0].count}
                        </span>
                      </button>
                    </div>
                    {allExpanded && (
                      <ul className="ml-3 space-y-1 border-l pl-2">
                        {categories.slice(1).map((cat) => {
                          const expanded = expandedCats.has(cat.name);
                          const catArticles =
                            articlesByCategory.get(cat.name) ?? [];
                          return (
                            <li key={cat.name}>
                              <div className="flex items-center gap-0.5">
                                <button
                                  type="button"
                                  onClick={() => toggleCat(cat.name)}
                                  aria-label={
                                    expanded
                                      ? m['blog.collapse']()
                                      : m['blog.expand']()
                                  }
                                  className="text-muted-foreground hover:text-primary flex size-6 shrink-0 items-center justify-center rounded-md"
                                >
                                  {expanded ? (
                                    <ChevronDown className="size-4" />
                                  ) : (
                                    <ChevronRight className="size-4" />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => selectCategory(cat.name)}
                                  className={cn(
                                    'flex flex-1 items-center justify-between rounded-lg px-3 py-2 text-left text-sm',
                                    activeCategory === cat.name
                                      ? 'bg-primary text-primary-foreground font-medium'
                                      : 'text-foreground hover:bg-muted'
                                  )}
                                >
                                  <span className="truncate">{cat.name}</span>
                                  <span
                                    className={cn(
                                      'ml-2 shrink-0 text-xs',
                                      activeCategory === cat.name
                                        ? 'text-primary-foreground/80'
                                        : 'text-muted-foreground'
                                    )}
                                  >
                                    {cat.count}
                                  </span>
                                </button>
                              </div>
                              {expanded && catArticles.length > 0 && (
                                <ul className="ml-3 space-y-0.5 border-l pl-2">
                                  {catArticles.map((post, idx) => (
                                    <li key={post.slug}>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          selectArticle(cat.name, idx)
                                        }
                                        className={cn(
                                          'block w-full truncate rounded px-2 py-1.5 text-left text-xs',
                                          post.slug === selected?.slug
                                            ? 'text-primary font-medium'
                                            : 'text-muted-foreground hover:text-primary'
                                        )}
                                      >
                                        {post.title}
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                </ul>
              </div>

              {/* 右：文章全文 */}
              <div className="bg-card border-border flex h-[70vh] flex-col overflow-hidden rounded-lg border">
                {!selected ? (
                  <div className="text-muted-foreground flex h-full items-center justify-center">
                    <p className="text-sm">{m['blog.no_posts']()}</p>
                  </div>
                ) : detailQuery.isPending ? (
                  <div className="text-muted-foreground flex h-full items-center justify-center">
                    <p className="text-sm">{m['blog.loading_article']()}</p>
                  </div>
                ) : !detail ? (
                  <div className="text-muted-foreground flex h-full items-center justify-center">
                    <p className="text-sm">{m['blog.no_posts']()}</p>
                  </div>
                ) : detail.requiresAuth ? (
                  <div className="mx-auto max-w-md px-6 py-16 text-center">
                    <h2 className="text-foreground text-2xl font-semibold tracking-tight">
                      {detail.title}
                    </h2>
                    {detail.description && (
                      <p className="text-muted-foreground mt-3">
                        {detail.description}
                      </p>
                    )}
                    <p className="text-muted-foreground mt-6 text-sm">
                      {m['blog.login_to_read']()}
                    </p>
                    <Link
                      href={`/sign-in?callbackUrl=${encodeURIComponent(`/blog/${detail.slug}`)}`}
                      className="bg-primary text-primary-foreground mt-6 inline-block min-h-[48px] rounded-lg px-8 py-3 font-medium"
                    >
                      {m['blog.sign_in']()}
                    </Link>
                  </div>
                ) : (
                  <>
                    <div className="border-border border-b px-6 py-5">
                      <h2 className="text-foreground text-2xl font-semibold tracking-tight">
                        {detail.title}
                      </h2>
                      <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-3 text-xs">
                        <span>{formatPostDate(detail.createdAt, locale)}</span>
                        {detail.authorName && <span>{detail.authorName}</span>}
                        {(detail.categories ?? []).map((c) => (
                          <span
                            key={c}
                            className="border-border rounded-full border px-2 py-0.5"
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                      {detail.description && (
                        <p className="text-muted-foreground mt-3 text-sm">
                          {detail.description}
                        </p>
                      )}
                    </div>
                    <div className="flex-1 overflow-y-auto px-6 py-6">
                      {detail.image && (
                        <img
                          src={detail.image}
                          alt={detail.title}
                          className="border-border mb-6 w-full rounded-2xl border object-cover"
                        />
                      )}
                      {LocalContent ? (
                        <div className="text-foreground/90 text-[15px] leading-7">
                          <MDXProvider components={mdxComponents}>
                            <LocalContent />
                          </MDXProvider>
                        </div>
                      ) : (
                        <MarkdownContent content={detail.content || ''} />
                      )}
                    </div>
                    <div className="border-border flex items-center justify-between border-t px-6 py-3">
                      <button
                        type="button"
                        onClick={goPrev}
                        disabled={safeIndex <= 0}
                        className="text-primary inline-flex items-center gap-1 text-sm font-medium disabled:opacity-40"
                      >
                        <ChevronLeft className="size-4" />
                        {m['blog.prev_article']()}
                      </button>
                      <span className="text-muted-foreground text-xs">
                        {m['blog.article_position']({
                          current: safeIndex + 1,
                          total: filtered.length,
                        })}
                      </span>
                      <button
                        type="button"
                        onClick={goNext}
                        disabled={safeIndex >= filtered.length - 1}
                        className="text-primary inline-flex items-center gap-1 text-sm font-medium disabled:opacity-40"
                      >
                        {m['blog.next_article']()}
                        <ChevronRight className="size-4" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
