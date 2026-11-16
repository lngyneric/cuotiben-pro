import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';

import { localizedAbsoluteUrl } from '@/core/i18n/urls';
import { envConfigs } from '@/config';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';
import { getLocale, locales } from '@/paraglide/runtime.js';
import { Footer } from '@/blocks/footer';
import { Header } from '@/blocks/header';
import { BlogCard } from '@/components/blog-card';
import { formatPostDate, type BlogPost } from '@/content/posts';
import { getBlogPostsFn } from '@/content/posts/server';

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

function BlogPage() {
  const { locale, posts } = Route.useLoaderData();
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>(
    m['blog.all_categories']()
  );

  // 分类：数据库文章的 categories（逗号分隔）展开去重；无分类的文章归“未分类”。
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of posts) {
      const cats = (p.categories ?? []).length
        ? (p.categories as string[])
        : ['未分类'];
      for (const c of cats) set.add(c);
    }
    return [m['blog.all_categories'](), ...Array.from(set).sort()];
  }, [posts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return posts.filter((p: BlogPost) => {
      const cats = (p.categories ?? []).length
        ? (p.categories as string[])
        : ['未分类'];
      if (
        activeCategory !== m['blog.all_categories']() &&
        !cats.includes(activeCategory)
      ) {
        return false;
      }
      if (!q) return true;
      return (
        p.title.toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q)
      );
    });
  }, [posts, search, activeCategory]);

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

          {/* 搜索 + 分类筛选 */}
          <div className="mx-auto mb-6 flex max-w-3xl flex-col gap-3">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={m['blog.search_placeholder']()}
              className="border-border bg-card w-full rounded-full border px-4 py-2 text-sm"
            />
            <div className="flex flex-wrap justify-center gap-1.5">
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs',
                    activeCategory === cat
                      ? 'border-primary text-primary font-medium'
                      : 'border-border text-muted-foreground'
                  )}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {filtered.length === 0 ? (
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
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
