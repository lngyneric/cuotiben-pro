import { useEffect, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';

import { useRouter } from '@/core/i18n/navigation';
import { localizedAbsoluteUrl } from '@/core/i18n/urls';
import { envConfigs } from '@/config';
import {
  checkLoginSync,
  hasRecentSyncFailure,
  recordSyncFailure,
  takeLoginJustSucceeded,
} from '@/lib/login-sync';
import { bridgeToAiShifu } from '@/lib/sso-bridge';
import { m } from '@/paraglide/messages.js';
import { getLocale, locales } from '@/paraglide/runtime.js';
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
 *
 * Intranet/AAD builds only: on open, check the wiki and ai-shifu login
 * states and make sure both are signed in before showing the page.
 * Public builds (AAD off) skip the check entirely — there is no ai-shifu
 * to sync with there.
 */
function HomePage() {
  const { posts } = Route.useLoaderData();
  const router = useRouter();
  // Build-time flag VITE_AAD_LOGIN_ENABLED; the public site never sets it.
  const aadEnabled = envConfigs.aad_login_enabled === 'true';
  const [guard, setGuard] = useState<'checking' | 'ready' | 'sync-failed'>(
    aadEnabled ? 'checking' : 'ready'
  );
  const [showSuccess, setShowSuccess] = useState(false);
  // The check runs once per page open; the ref also guards StrictMode
  // double-invoking the effect.
  const checkedRef = useRef(false);

  useEffect(() => {
    if (!aadEnabled || checkedRef.current) return;
    checkedRef.current = true;
    let cancelled = false;
    void (async () => {
      const status = await checkLoginSync();
      if (cancelled) return;
      // Wiki not signed in: go re-verify, replacing history so Back
      // doesn't land here and bounce straight back to sign-in.
      if (!status.wiki) {
        router.replace('/sign-in?callbackUrl=/');
        return;
      }
      if (!status.aishifu) {
        // Wiki is signed in but ai-shifu isn't: try the SSO bridge once —
        // it navigates away and ai-shifu sends the user back here, where
        // the check runs again and should now pass.
        const bridged = await bridgeToAiShifu('/');
        if (cancelled) return;
        if (bridged) return;
        // Bridge unavailable (ran within 10 minutes, or the SSO endpoint
        // failed): if we already bounced for this within a minute, stop
        // looping and show a banner instead.
        if (hasRecentSyncFailure()) {
          setGuard('sync-failed');
          return;
        }
        recordSyncFailure();
        router.replace('/sign-in?callbackUrl=/&reauth=1');
        return;
      }
      if (takeLoginJustSucceeded()) setShowSuccess(true);
      setGuard('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [aadEnabled, router]);

  if (guard === 'checking') {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="border-primary size-6 animate-spin rounded-full border-2 border-t-transparent" />
          <span className="text-muted-foreground text-sm">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      {showSuccess && (
        <div
          role="status"
          className="flex items-center justify-center gap-3 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900"
        >
          <span>登录成功，wiki 与 ai-shifu 已同步登录</span>
          <button
            type="button"
            onClick={() => setShowSuccess(false)}
            className="rounded px-2 py-0.5 underline underline-offset-4"
          >
            关闭
          </button>
        </div>
      )}
      {guard === 'sync-failed' && (
        <div
          role="status"
          className="flex items-center justify-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"
        >
          <span>ai-shifu 同步登录失败，请重新登录</span>
          <button
            type="button"
            onClick={() => router.replace('/sign-in?callbackUrl=/&reauth=1')}
            className="rounded px-2 py-0.5 underline underline-offset-4"
          >
            重新登录
          </button>
        </div>
      )}
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
    const urlFor = (loc: string) => localizedAbsoluteUrl('/', loc);
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
