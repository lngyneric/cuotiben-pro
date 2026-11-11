import { useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';

import { tDynamic } from '@/core/i18n/dynamic';
import { Link } from '@/core/i18n/navigation';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';

// Four growth stages. Copy, badges and audiences follow the approved
// reference exactly; tab content is real content only (see below).
const TRACKS = [
  { id: 'newcomer', emoji: '🎓' },
  { id: 'mentorship', emoji: '📚' },
  { id: 'crash', emoji: '🔥' },
  { id: 'leadership', emoji: '⭐' },
] as const;

type TrackId = (typeof TRACKS)[number]['id'];

const DOC_COUNT = 9;
const VIDEO_COUNT = 9;

function TrackCard({
  id,
  emoji,
  active,
  onSelect,
}: {
  id: TrackId;
  emoji: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'border-border bg-card hover:border-foreground/20 flex flex-col rounded-2xl border p-6 text-left transition-all hover:shadow-sm',
        active && 'border-foreground/40 shadow-sm'
      )}
    >
      <span className="text-3xl" aria-hidden="true">
        {emoji}
      </span>
      <h3 className="mt-4 text-lg font-medium">
        {tDynamic(`landing.tracks.${id}.title`)}
      </h3>
      <p className="text-muted-foreground mt-2 flex-1 text-sm leading-relaxed">
        {tDynamic(`landing.tracks.${id}.description`)}
      </p>
      <span className="mt-5 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-sky-100 px-2.5 py-1 text-xs font-medium text-sky-700 dark:bg-sky-900/50 dark:text-sky-300">
          {m['landing.tracks.badge_coming_soon']()}
        </span>
        <span className="text-muted-foreground text-sm">
          {tDynamic(`landing.tracks.${id}.audience`)}
        </span>
      </span>
    </button>
  );
}

function NewcomerContent() {
  return (
    <div>
      <h3 className="text-lg font-medium">
        {m['landing.tracks.newcomer.docs_title']()}
      </h3>
      <ul className="divide-border mt-5 divide-y">
        {Array.from({ length: DOC_COUNT }, (_, i) => {
          const num = String(i).padStart(2, '0');
          return (
            <li key={num}>
              <Link
                href="/blog"
                className="group hover:text-foreground flex items-center justify-between gap-4 py-3 text-sm transition-colors"
              >
                <span className="text-muted-foreground group-hover:text-foreground">
                  {tDynamic(`landing.tracks.newcomer.doc.${num}`)}
                </span>
                <ArrowRight className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-5">
        <Link
          href="/blog"
          className="text-primary inline-flex items-center gap-1.5 text-sm font-medium"
        >
          {m['landing.tracks.newcomer.view_all']()}
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </div>
  );
}

function MentorshipContent() {
  const points = ['point_general', 'point_sales', 'point_milestones'];
  return (
    <div>
      <ul className="space-y-4">
        {points.map((point) => (
          <li
            key={point}
            className="flex items-start gap-3 text-sm leading-relaxed"
          >
            <span className="bg-primary/10 text-primary mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full">
              <Check className="size-3" strokeWidth={3} />
            </span>
            {tDynamic(`landing.tracks.mentorship.${point}`)}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground mt-6 text-sm leading-relaxed">
        {m['landing.tracks.mentorship.note']()}
      </p>
      <div className="mt-5">
        <Link
          href="/blog"
          className="text-primary inline-flex items-center gap-1.5 text-sm font-medium"
        >
          {m['landing.tracks.mentorship.view_all']()}
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </div>
  );
}

function CrashContent() {
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="text-lg font-medium">
          {m['landing.tracks.crash.list_title']()}
        </h3>
        <span className="text-muted-foreground text-sm">
          {m['landing.tracks.crash.list_note']()}
        </span>
      </div>
      <ul className="divide-border mt-5 divide-y">
        {Array.from({ length: VIDEO_COUNT }, (_, i) => (
          <li
            key={i}
            className="flex items-center justify-between gap-4 py-3 text-sm"
          >
            <span>{tDynamic(`landing.tracks.crash.video.${i}`)}</span>
            <span className="shrink-0 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              {m['landing.tracks.badge_live']()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LeadershipContent() {
  return (
    <div>
      <p className="text-sm leading-relaxed">
        {tDynamic('landing.tracks.leadership.description')}
      </p>
      <p className="text-muted-foreground mt-4 text-sm leading-relaxed">
        {m['landing.tracks.leadership.note']()}
      </p>
    </div>
  );
}

export function CourseTracks() {
  const [active, setActive] = useState<TrackId>('newcomer');

  return (
    <section id="courses" className="scroll-mt-20 px-4 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl">
        <div className="mb-12 text-center">
          <h2 className="font-serif text-4xl font-medium tracking-tight sm:text-5xl">
            {m['landing.tracks.title']()}
          </h2>
          <p className="text-muted-foreground mx-auto mt-5 max-w-lg">
            {m['landing.tracks.description']()}
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {TRACKS.map((track) => (
            <TrackCard
              key={track.id}
              id={track.id}
              emoji={track.emoji}
              active={active === track.id}
              onSelect={() => setActive(track.id)}
            />
          ))}
        </div>

        <div
          role="tablist"
          aria-label={m['landing.tracks.title']()}
          className="mt-10 flex flex-wrap justify-center gap-2"
        >
          {TRACKS.map((track) => (
            <button
              key={track.id}
              type="button"
              role="tab"
              aria-selected={active === track.id}
              onClick={() => setActive(track.id)}
              className={cn(
                'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors',
                active === track.id
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <span aria-hidden="true">{track.emoji}</span>
              {tDynamic(`landing.tracks.${track.id}.title`)}
            </button>
          ))}
        </div>

        <div className="border-border bg-card mx-auto mt-6 max-w-4xl rounded-2xl border p-6 sm:p-8">
          {active === 'newcomer' && <NewcomerContent />}
          {active === 'mentorship' && <MentorshipContent />}
          {active === 'crash' && <CrashContent />}
          {active === 'leadership' && <LeadershipContent />}
        </div>
      </div>
    </section>
  );
}
