import { useState } from 'react';
import { ArrowRight } from 'lucide-react';

import { tDynamic } from '@/core/i18n/dynamic';
import { Link } from '@/core/i18n/navigation';
import { envConfigs } from '@/config';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';
import { buttonVariants } from '@/components/ui/button';

// Remote Unsplash photo (people learning together). Verified 200 at build
// time; the fallback swaps in if the primary fails to load. The section
// keeps a solid dark background so the hero still reads if both fail.
// No binary image files are committed to the repo.
const HERO_IMAGE_PRIMARY =
  'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=2000&q=80';
const HERO_IMAGE_FALLBACK =
  'https://images.unsplash.com/photo-1524178232363-1fb2b075b655?auto=format&fit=crop&w=2000&q=80';

const HIGHLIGHTS = [
  { key: 'newcomer', emoji: '🎓', href: '/blog' },
  { key: 'notebook', emoji: '📝', href: '/cuotiben' },
  { key: 'assistant', emoji: '🤖', href: '/blog' },
] as const;

export function Hero() {
  const [heroSrc, setHeroSrc] = useState(HERO_IMAGE_PRIMARY);

  return (
    <>
      <section className="relative isolate overflow-hidden bg-neutral-950">
        <img
          src={heroSrc}
          onError={() => {
            if (heroSrc !== HERO_IMAGE_FALLBACK) {
              setHeroSrc(HERO_IMAGE_FALLBACK);
            }
          }}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-black/60" />
        <div className="relative mx-auto flex min-h-[560px] w-full max-w-6xl flex-col justify-end px-4 pt-32 pb-16 sm:min-h-[640px] sm:px-6 sm:pb-20">
          <p className="text-xs font-semibold tracking-[0.25em] text-white/80 uppercase">
            {envConfigs.app_name}
          </p>
          <h1 className="mt-4 max-w-3xl font-serif text-5xl leading-[1.05] font-medium tracking-tight text-white sm:text-6xl lg:text-7xl">
            {m['landing.hero.headline']()}
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-white/85">
            {m['landing.hero.subheadline']()}
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/blog"
              className={cn(
                buttonVariants({ size: 'lg' }),
                'h-12 gap-2 rounded-full px-8'
              )}
            >
              {m['landing.hero.cta']()}
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href="/sign-in"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-white/60 px-8 text-sm font-medium text-white transition-colors hover:bg-white/10"
            >
              {m['landing.hero.secondary']()}
            </Link>
          </div>
        </div>
      </section>

      <section className="px-4 py-12 sm:py-16">
        <div className="mx-auto grid max-w-6xl gap-5 sm:grid-cols-3">
          {HIGHLIGHTS.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className="group border-border bg-card hover:border-foreground/20 block rounded-2xl border p-6 transition-all hover:shadow-sm"
            >
              <span className="text-3xl" aria-hidden="true">
                {item.emoji}
              </span>
              <h3 className="mt-4 font-medium">
                {tDynamic(`landing.highlights.${item.key}.title`)}
              </h3>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                {tDynamic(`landing.highlights.${item.key}.description`)}
              </p>
              <span className="text-primary mt-4 inline-flex items-center gap-1.5 text-sm font-medium">
                {tDynamic(`landing.highlights.${item.key}.link`)}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
