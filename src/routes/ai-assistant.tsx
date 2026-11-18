import { useEffect, useRef, useState } from 'react';
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

interface ChatResult {
  answer: string;
  courses: RecommendedCourse[];
  sources: DocSource[];
  mode: 'chat' | 'keyword' | 'doc';
  found: boolean;
}

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  courses?: RecommendedCourse[];
  sources?: DocSource[];
}

const TOPIC_KEYS = [
  'ai_assistant.topic_leadership',
  'ai_assistant.topic_lab',
  'ai_assistant.topic_sales',
  'ai_assistant.topic_newcomer',
] as const;

/** 对话历史只存本机浏览器（刷新不丢；换设备不带走）。 */
const CHAT_STORAGE_KEY = 'ai-assistant-chat-v1';

function loadStoredMessages(): ChatMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is ChatMessage =>
          !!m &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.text === 'string'
      )
      .slice(-30);
  } catch {
    return [];
  }
}

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

function CourseCard({ course }: { course: RecommendedCourse }) {
  return (
    <article className="border-border bg-card rounded-2xl border p-6">
      <span className="text-primary text-xs font-medium">
        {course.type === 'video'
          ? m['ai_assistant.video']()
          : m['ai_assistant.text']()}
      </span>
      <h2 className="mt-2 text-lg font-medium">{course.title}</h2>
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
  );
}

function SourceCard({ source }: { source: DocSource }) {
  return (
    <a
      key={source.url}
      href={source.url}
      target="_blank"
      rel="noreferrer"
      className="border-border flex items-center justify-between gap-2 rounded-xl border px-4 py-3 text-sm"
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
  );
}

function AiAssistantPage() {
  const { data: session, isPending: sessionPending } = useSession();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const idRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 刷新后恢复本机保存的对话（只在客户端跑，避免服务端渲染不一致）。
  useEffect(() => {
    const stored = loadStoredMessages();
    if (stored.length > 0) {
      idRef.current = stored.reduce((max, m) => Math.max(max, m.id || 0), 0);
      setMessages(stored);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(
        CHAT_STORAGE_KEY,
        JSON.stringify(messages.slice(-30))
      );
    } catch {
      // 存储满或被禁时静默跳过，不影响对话。
    }
  }, [messages]);

  const mutation = useMutation({
    mutationFn: (vars: {
      query: string;
      history: { role: 'user' | 'assistant'; content: string }[];
    }) => apiPost<ChatResult>('/api/ai-assistant/chat', vars),
    onSuccess: (data) => {
      setMessages((prev) => [
        ...prev,
        {
          id: ++idRef.current,
          role: 'assistant',
          text: data.answer,
          courses: data.courses,
          sources: data.sources,
        },
      ]);
    },
  });

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || mutation.isPending) return;
    const history = messages
      .slice(-20)
      .map((msg) => ({ role: msg.role, content: msg.text }));
    setMessages((prev) => [
      ...prev,
      { id: ++idRef.current, role: 'user', text: trimmed },
    ]);
    setInput('');
    mutation.mutate({ query: trimmed, history });
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, mutation.isPending]);

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
            // 大圆卡片 1：先验证身份，再对话。
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
              <div className="mb-4 flex items-center justify-center gap-3 text-xs">
                <span className="text-muted-foreground">
                  {m['ai_assistant.signed_in']()}
                </span>
                {messages.length > 0 && (
                  <button
                    type="button"
                    disabled={mutation.isPending}
                    onClick={() => {
                      setMessages([]);
                      if (typeof window !== 'undefined')
                        window.localStorage.removeItem(CHAT_STORAGE_KEY);
                    }}
                    className="text-muted-foreground hover:text-primary underline disabled:opacity-50"
                  >
                    {m['ai_assistant.clear']()}
                  </button>
                )}
              </div>

              <div className="space-y-4">
                {messages.map((msg) =>
                  msg.role === 'user' ? (
                    <div key={msg.id} className="flex justify-end">
                      <div className="bg-primary text-primary-foreground max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
                        {msg.text}
                      </div>
                    </div>
                  ) : (
                    <div key={msg.id} className="space-y-3">
                      <div className="border-border bg-card max-w-[95%] rounded-2xl rounded-bl-sm border px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
                        {msg.text}
                      </div>
                      {msg.courses?.map((course) => (
                        <CourseCard key={course.slug} course={course} />
                      ))}
                      {msg.sources?.map((source) => (
                        <SourceCard key={source.url} source={source} />
                      ))}
                    </div>
                  )
                )}
                {mutation.isPending && (
                  <div className="border-border bg-card text-muted-foreground max-w-[95%] rounded-2xl rounded-bl-sm border px-4 py-2.5 text-sm">
                    {m['ai_assistant.thinking']()}
                  </div>
                )}
                <div ref={bottomRef} />
              </div>

              {messages.length === 0 && (
                <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                  {TOPIC_KEYS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      disabled={mutation.isPending}
                      onClick={() => send(m[key]())}
                      className="border-border text-muted-foreground hover:text-primary rounded-full border px-2.5 py-1 text-xs disabled:opacity-50"
                    >
                      {m[key]()}
                    </button>
                  ))}
                </div>
              )}

              {mutation.isError && (
                <p className="mt-6 text-center text-sm text-red-600">
                  {mutation.error instanceof Error
                    ? mutation.error.message
                    : m['ai_assistant.error']()}
                </p>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  send(input);
                }}
                className="mx-auto mt-6 flex max-w-xl gap-2"
              >
                <input
                  type="search"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={m['ai_assistant.chat_placeholder']()}
                  maxLength={200}
                  className="border-border bg-card min-w-0 flex-1 rounded-full border px-4 py-2 text-sm"
                />
                <button
                  type="submit"
                  disabled={mutation.isPending || !input.trim()}
                  className={cn(
                    buttonVariants(),
                    'shrink-0 rounded-full px-5 disabled:opacity-50'
                  )}
                >
                  {m['ai_assistant.send']()}
                </button>
              </form>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
