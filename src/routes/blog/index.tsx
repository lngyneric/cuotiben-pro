import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';

import { envConfigs } from '@/config';
import { m } from '@/paraglide/messages.js';
import { getLocale, locales, localizeUrl } from '@/paraglide/runtime.js';
import { Footer } from '@/blocks/footer';
import { Header } from '@/blocks/header';

import { HtmlList, HtmlUpload } from './-html-upload';

export const Route = createFileRoute('/blog/')({
  loader: async () => {
    const locale = getLocale();
    return { locale };
  },
  head: ({ loaderData }) => {
    const locale = loaderData?.locale;
    const urlFor = (loc: string) =>
      localizeUrl(`${envConfigs.app_url}/blog`, { locale: loc as any }).href;
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
        { rel: 'canonical', href: urlFor(locale ?? 'en') },
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
  const { locale } = Route.useLoaderData();
  const [selected, setSelected] = useState<any>(null);

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

          {/* 左右分屏 */}
          <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
            {/* 左：列表 */}
            <div className="bg-card border-border max-h-[70vh] overflow-hidden rounded-lg border p-4">
              <HtmlList
                locale={locale}
                selected={selected}
                onSelect={setSelected}
              />
            </div>

            {/* 右：预览 */}
            <div className="bg-card border-border min-h-[70vh] overflow-hidden rounded-lg border">
              {selected ? (
                <div className="flex h-full flex-col">
                  <div className="border-border flex items-center justify-between border-b p-4">
                    <div>
                      <h2 className="text-foreground text-lg font-semibold tracking-tight">
                        {selected.title}
                      </h2>
                      {selected.description && (
                        <p className="text-muted-foreground mt-1 line-clamp-1 text-sm">
                          {selected.description}
                        </p>
                      )}
                    </div>
                    <a
                      href={selected.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary inline-flex shrink-0 items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
                    >
                      新窗口 <ExternalLink className="size-3" />
                    </a>
                  </div>
                  <iframe
                    src={selected.url}
                    className="w-full flex-1 border-0"
                    style={{ minHeight: '60vh' }}
                    title={selected.title}
                    sandbox="allow-same-origin"
                  />
                </div>
              ) : (
                <div className="text-muted-foreground flex h-full min-h-[60vh] items-center justify-center">
                  <p className="text-sm">← 从左侧选择一篇文章预览</p>
                </div>
              )}
            </div>
          </div>

          <div className="mt-4">
            <HtmlUpload />
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
