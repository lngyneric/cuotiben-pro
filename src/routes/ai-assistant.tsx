import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

import { useSession } from '@/core/auth/client';
import { Link } from '@/core/i18n/navigation';
import { localizedAbsoluteUrl } from '@/core/i18n/urls';
import { envConfigs } from '@/config';
import { apiPost } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';
import { getLocale, locales } from '@/paraglide/runtime.js';
import { Footer } from '@/blocks/footer';
import { Header } from '@/blocks/header';
import { buttonVariants } from '@/components/ui/button';

interface RecommendedCourse {
  slug: string;
  title: string;
  description: string;
  categories: string[];
  type: 'video' | 'text';
  link: string;
}

interface DocSource {
  docTitle: string;
  sectionTitle: string;
  url: string;
}

interface RecommendResult {
  mode: 'ai' | 'keyword' | 'doc';
  found: boolean;
  courses: RecommendedCourse[];
  answer?: string;
  sources?: DocSource[];
}

const TOPIC_KEYS = [
  'ai_assistant.topic_leadership',
  'ai_assistant.topic_lab',
  'ai_assistant.topic_sales',
  'ai_assistant.topic_newcomer',
] as const;

export const Route = createFileRoute('/ai-assistant')({
  loader: async () => {
    const locale = getLocale();
    return { locale };
  },
  head: ({ loaderData }) => {
    const locale = loaderData?.locale ?? 'zh';
    const urlFor = (loc: string) => localizedAbsoluteUrl('/ai-assistant', loc);
    return {
      meta: [
        {
          title: `${m['ai_assistant.title']({}, { locale: locale as any })} | ${envConfigs.app_name}`,
        },
        {
          name: 'description',
          content: m['ai_assistant.description']({}, { locale: locale as any }),
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
  component: AiAssistantPage,
});

function AiAssistantPage() {
  const { data: session, isPending: sessionPending } = useSession();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<RecommendResult | null>(null);

  const mutation = useMutation({
    mutationFn: (q: string) =>
      apiPost<RecommendResult>('/api/ai-assistant/recommend', { query: q }),
    onSuccess: (data) => setResult(data),
  });

  const ask = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || mutation.isPending) return;
    setQuery(trimmed);
    setResult(null);
    mutation.mutate(trimmed);
  };

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <Header />
      <main className="flex-1 px-4 py-8">
        <div className="mx-auto max-w-3xl">
          <div className="mb-6 text-center">
            <h1 className="font-serif text-3xl font-normal tracking-tight sm:text-4xl">
              {m['ai_assistant.title']()}
            </h1>
            <p className="text-muted-foreground mx-auto mt-3 max-w-lg text-sm">
              {m['ai_assistant.description']()}
            </p>
          </div>

          {sessionPending ? null : !session?.user ? (
            // 大圆卡片 1：先验证身份，再找课。
            <div className="border-border bg-card mx-auto max-w-lg rounded-2xl border p-6 text-center">
              <h2 className="font-medium">
                {m['ai_assistant.login_required_title']()}
              </h2>
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
          ) : (
            <>
              <p className="text-muted-foreground mb-4 text-center text-xs">
                {m['ai_assistant.signed_in']()}
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  ask(query);
                }}
                className="mx-auto flex max-w-xl gap-2"
              >
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={m['ai_assistant.placeholder']()}
                  maxLength={200}
                  className="border-border bg-card min-w-0 flex-1 rounded-full border px-4 py-2 text-sm"
                />
                <button
                  type="submit"
                  disabled={mutation.isPending || !query.trim()}
                  className={cn(
                    buttonVariants(),
                    'shrink-0 rounded-full px-5 disabled:opacity-50'
                  )}
                >
                  {mutation.isPending
                    ? m['ai_assistant.loading']()
                    : m['ai_assistant.ask']()}
                </button>
              </form>

              <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                {TOPIC_KEYS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    disabled={mutation.isPending}
                    onClick={() => ask(m[key]())}
                    className="border-border text-muted-foreground hover:text-primary rounded-full border px-2.5 py-1 text-xs disabled:opacity-50"
                  >
                    {m[key]()}
                  </button>
                ))}
              </div>

              {mutation.isError && (
                <p className="mt-6 text-center text-sm text-red-600">
                  {mutation.error instanceof Error
                    ? mutation.error.message
                    : m['ai_assistant.error']()}
                </p>
              )}

              {result && result.found && result.mode === 'doc' && (
                <div className="mt-8 space-y-4">
                  <p className="text-muted-foreground text-center text-xs">
                    {m['ai_assistant.mode_doc']()}
                  </p>
                  <article className="border-border bg-card rounded-2xl border p-6">
                    <p className="text-sm leading-relaxed whitespace-pre-wrap">
                      {result.answer}
                    </p>
                    {result.sources?.map((source) => (
                      <a
                        key={source.url}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="border-border mt-4 flex items-center justify-between gap-2 rounded-xl border px-4 py-3 text-sm"
                      >
                        <span>
                          <span className="text-muted-foreground block text-xs">
                            {m['ai_assistant.doc_source']()}
                          </span>
                          <span className="font-medium">
                            {source.docTitle} · {source.sectionTitle}
                          </span>
                        </span>
                        <span className="text-primary shrink-0 font-medium">
                          {m['ai_assistant.open_doc']()} ↗
                        </span>
                      </a>
                    ))}
                  </article>
                </div>
              )}

              {result && result.found && result.mode !== 'doc' && (
                <div className="mt-8 space-y-4">
                  <p className="text-muted-foreground text-center text-xs">
                    {result.mode === 'ai'
                      ? m['ai_assistant.mode_ai']()
                      : m['ai_assistant.mode_keyword']()}
                  </p>
                  {result.courses.map((course) => (
                    <article
                      key={course.slug}
                      className="border-border bg-card rounded-2xl border p-6"
                    >
                      <span className="text-primary text-xs font-medium">
                        {course.type === 'video'
                          ? m['ai_assistant.video']()
                          : m['ai_assistant.text']()}
                      </span>
                      <h2 className="mt-2 text-lg font-medium">
                        {course.title}
                      </h2>
                      {course.description && (
                        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                          {course.description}
                        </p>
                      )}
                      <a
                        href={course.link}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary mt-4 inline-flex items-center gap-1.5 text-sm font-medium"
                      >
                        {m['ai_assistant.open_course']()} ↗
                      </a>
                    </article>
                  ))}
                </div>
              )}

              {result && !result.found && (
                // 大圆卡片 5：没找到匹配的课。
                <div className="border-border bg-card mx-auto mt-8 max-w-lg rounded-2xl border p-6 text-center">
                  <p className="text-sm leading-relaxed">
                    {m['ai_assistant.not_found']({ query })}
                  </p>
                  <p className="text-muted-foreground mt-2 text-sm">
                    {m['ai_assistant.not_found_hint']()}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
