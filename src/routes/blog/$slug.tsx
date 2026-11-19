import { useMutation } from '@tanstack/react-query';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { MDXProvider } from '@mdx-js/react';
import { ArrowLeft, Calendar } from 'lucide-react';
import { toast } from 'sonner';

import { Link } from '@/core/i18n/navigation';
import { localizedAbsoluteUrl } from '@/core/i18n/urls';
import { envConfigs } from '@/config';
import { apiPost } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';
import { getLocale } from '@/paraglide/runtime.js';
import { Footer } from '@/blocks/footer';
import { Header } from '@/blocks/header';
import { MarkdownContent } from '@/components/markdown-content';
import { mdxComponents } from '@/components/mdx-components';
import { Button, buttonVariants } from '@/components/ui/button';
import { formatPostDate, loadLocalPost } from '@/content/posts';
import { getBlogPostFn } from '@/content/posts/server';

export const Route = createFileRoute('/blog/$slug')({
  loader: async ({ params }) => {
    const locale = getLocale();
    const post = await getBlogPostFn({
      data: { slug: params.slug, locale },
    });
    if (!post) throw notFound();
    return { locale, post };
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { locale, post } = loaderData;
    const canonical = localizedAbsoluteUrl(`/blog/${post.slug}`, locale as any);
    return {
      meta: [
        { title: `${post.title} | ${envConfigs.app_name}` },
        { name: 'description', content: post.description },
      ],
      links: [{ rel: 'canonical', href: canonical }],
    };
  },
  component: BlogPostPage,
});

function BlogPostPage() {
  const { locale, post } = Route.useLoaderData();

  // Local posts render their bundled MDX component; database posts render
  // raw markdown through MarkdownContent.
  const LocalContent =
    post.source === 'local' ? loadLocalPost(post.slug, locale)?.default : null;

  // 草稿预览：管理员在文章页确认内容后直接发布
  const publishMutation = useMutation({
    mutationFn: () =>
      apiPost<{ updated: number }>('/api/admin/posts/batch-status', {
        ids: [post.id as string],
        status: 'published',
      }),
    onSuccess: () => {
      toast.success(m['blog.draft_preview_published']());
      window.location.reload();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // 成员专属文章且未登录：不渲染正文，提示登录
  if (post.requiresAuth) {
    return (
      <div className="bg-background text-foreground flex min-h-screen flex-col">
        <Header />
        <main className="flex flex-1 items-center justify-center px-6 py-16">
          <div className="mx-auto max-w-md text-center">
            <h1 className="text-foreground text-2xl font-semibold tracking-tight">
              {post.title}
            </h1>
            {post.description && (
              <p className="text-muted-foreground mt-3">{post.description}</p>
            )}
            <p className="text-muted-foreground mt-6 text-sm">
              这篇文章仅对注册用户开放，请先登录后查看。
            </p>
            <Link
              href={`/sign-in?callbackUrl=${encodeURIComponent(`/blog/${post.slug}`)}`}
              className="bg-primary text-primary-foreground mt-6 inline-block min-h-[48px] rounded-lg px-8 py-3 font-medium"
            >
              去登录
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
      <main className="flex-1 px-6 py-12 md:px-8 md:py-16">
        {post.isDraftPreview && post.id && (
          <div className="mx-auto mb-6 max-w-3xl rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              {m['blog.draft_preview_notice']()}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={publishMutation.isPending}
                onClick={() => publishMutation.mutate()}
              >
                {m['blog.draft_preview_publish']()}
              </Button>
              <Link
                href="/admin/posts"
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'sm' })
                )}
              >
                {m['blog.draft_preview_back_to_posts']()}
              </Link>
            </div>
          </div>
        )}
        <article className="mx-auto max-w-3xl">
          <Link
            href="/blog"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-2 text-sm font-medium transition-colors"
          >
            <ArrowLeft className="size-4" />
            {m['blog.back_to_blog']()}
          </Link>

          <header className="border-border mt-8 mb-6 border-b pb-6">
            <h1 className="text-foreground text-3xl font-semibold tracking-tight md:text-4xl">
              {post.title}
            </h1>
            <div className="text-muted-foreground mt-4 flex items-center gap-4 text-sm">
              <span className="inline-flex items-center gap-1.5">
                <Calendar className="size-4" />
                {formatPostDate(post.createdAt, locale)}
              </span>
              {(post.authorName || post.authorImage) && (
                <span className="inline-flex items-center gap-2">
                  {post.authorImage && (
                    <img
                      src={post.authorImage}
                      alt={post.authorName || ''}
                      width={20}
                      height={20}
                      className="size-5 rounded-full object-cover"
                    />
                  )}
                  {post.authorName}
                </span>
              )}
            </div>
          </header>

          {post.description && (
            <p className="text-muted-foreground mb-6">{post.description}</p>
          )}

          {post.image && (
            <img
              src={post.image}
              alt={post.title}
              className="border-border mb-8 w-full rounded-2xl border object-cover"
            />
          )}

          {LocalContent ? (
            <div className="text-foreground/90 text-[15px] leading-7">
              <MDXProvider components={mdxComponents}>
                <LocalContent />
              </MDXProvider>
            </div>
          ) : (
            <MarkdownContent content={post.content || ''} />
          )}
        </article>
      </main>
      <Footer />
    </div>
  );
}
