import { Check, ChevronDown, Globe, Languages } from 'lucide-react';

import { switchLocale } from '@/core/i18n/urls';
import { localeNames } from '@/config/locale';
import { cn } from '@/lib/utils';
import { getLocale, locales } from '@/paraglide/runtime.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function LocaleSelector({
  variant = 'icon',
  className,
}: {
  variant?: 'icon' | 'pill';
  className?: string;
}) {
  const locale = getLocale();

  function handleSwitch(newLocale: string) {
    // Base-path-aware: paraglide's setLocale() would localize the full URL
    // and send intranet users to /en/wiki (404). See core/i18n/urls.ts.
    switchLocale(newLocale);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'inline-flex items-center transition-colors outline-none',
          variant === 'icon'
            ? 'text-muted-foreground hover:bg-accent hover:text-accent-foreground size-8 justify-center rounded-md'
            : 'h-9 gap-2 rounded-full border px-4 text-sm',
          className
        )}
      >
        {variant === 'icon' ? (
          <>
            <Languages className="size-4" />
            <span className="sr-only">Switch language</span>
          </>
        ) : (
          <>
            <Globe className="size-4" />
            <span>{localeNames[locale] || locale}</span>
            <ChevronDown className="size-4 opacity-70" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {locales.map((loc) => (
          <DropdownMenuItem
            key={loc}
            onClick={() => handleSwitch(loc)}
            className="flex items-center justify-between gap-2"
          >
            {localeNames[loc] || loc}
            {loc === locale && <Check className="size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
