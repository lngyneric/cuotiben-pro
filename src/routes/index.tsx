import { createFileRoute } from '@tanstack/react-router';

import { envConfigs } from '@/config';
import { m } from '@/paraglide/messages.js';
import { getLocale, locales, localizeUrl } from '@/paraglide/runtime.js';
import { Blog } from '@/blocks/blog';
import { CourseTracks } from '@/blocks/course-tracks';
import { CTA } from '@/blocks/cta';
import { FAQ } from '@/blocks/faq';
import { Footer } from '@/blocks/footer';
import { Header } from '@/blocks/header';
import { Hero } from '@/blocks/hero';
import { Mission } from '@/blocks/mission';
import { SupportWidget } from '@/blocks/support-widget';
import { getBlogPostsFn } from '@/content/posts/server';

/**
 * 企业大学 AI-Coach landing page (MIT HR style): photo hero with a
 * highlight row, the four course tracks with tabs, a mission section,
 * then blog, FAQ and CTA. Pricing and the generic Features section are
 * not part of this page (the files stay for other routes).
 */
function HomePage() {
  const { posts } = Route.useLoaderData();

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <Header />
      <main>
        <Hero />
        <CourseTracks />
        <Mission />
        <Blog posts={posts} />
        <FAQ />
        <CTA />
      </main>
      <Footer />
      <SupportWidget />
    </div>
  );
}

export const Route = createFileRoute('/')({
  loader: async () => {
    const locale = getLocale();
    const posts = await getBlogPostsFn({ data: { locale, limit: 3 } });
    return { locale, posts };
  },
  head: ({ loaderData }) => {
    const locale = loaderData?.locale ?? 'zh';
    const urlFor = (loc: string) =>
      localizeUrl(`${envConfigs.app_url}/`, { locale: loc as any }).href;
    return {
      meta: [
        {
          name: 'description',
          content: m['landing.hero.subheadline']({}, { locale: locale as any }),
        },
      ],
      links: [
        { rel: 'canonical', href: urlFor(locale) },
        ...locales.map((loc) => ({
          rel: 'alternate',
          hrefLang: loc,
          href: urlFor(loc),
        })),
        { rel: 'alternate', hrefLang: 'x-default', href: urlFor('zh') },
      ],
    };
  },
  component: HomePage,
});
