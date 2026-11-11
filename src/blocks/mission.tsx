import { ArrowRight } from 'lucide-react';

import { Link } from '@/core/i18n/navigation';
import { m } from '@/paraglide/messages.js';

// "Discover" section in the MIT HR style: a mission statement with one
// link onward to the blog, where the learning content lives.
export function Mission() {
  return (
    <section className="bg-muted/50 px-4 py-24 sm:py-32">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="font-serif text-4xl font-medium tracking-tight sm:text-5xl">
          {m['landing.mission.title']()}
        </h2>
        <p className="text-muted-foreground mx-auto mt-6 max-w-2xl text-base leading-relaxed sm:text-lg">
          {m['landing.mission.paragraph']()}
        </p>
        <div className="mt-8">
          <Link
            href="/blog"
            className="text-primary inline-flex items-center gap-2 text-sm font-medium"
          >
            {m['landing.mission.cta']()}
            <ArrowRight className="size-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}
