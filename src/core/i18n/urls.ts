import { envConfigs } from '@/config';
import { getAppBasePath, withAppBase } from '@/lib/base-path';
import { localizeHref, setLocale } from '@/paraglide/runtime.js';

// Paraglide's localizeUrl / setLocale operate on the full request URL and do
// not know the app base path (/wiki on the intranet build): localizing
// `https://eu.sysmex.com.cn/wiki/blog` to en yields `/en/wiki/blog` (404),
// and setLocale() on the language switcher sent users there. Every direct
// Paraglide URL call must go through these helpers instead: localize the
// root-relative path first, then prepend the base path. (The TanStack router
// rewrite already does this internally, so router <Link> / navigate() are
// unaffected.)

/** Origin the absolute URLs should use. On the client, VITE_APP_URL may not
 *  have been inlined into the bundle (dev builds fall back to localhost) —
 *  prefer the live origin there. */
function appOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  try {
    return new URL(envConfigs.app_url).origin;
  } catch {
    return '';
  }
}

/**
 * Absolute URL for a root-relative path in the given locale, e.g. `/blog` + en
 * → `https://eu.sysmex.com.cn/wiki/en/blog`. Use for canonical / hreflang /
 * sitemap links, never paraglide's localizeUrl on the full app URL.
 */
export function localizedAbsoluteUrl(path: string, locale: string): string {
  return `${appOrigin()}${withAppBase(localizeHref(path, { locale: locale as any }))}`;
}

/**
 * Switch locale from the language switcher. Strips the base path before
 * localizing (so /wiki/blog → /wiki/en/blog, not /en/wiki/blog), writes the
 * locale cookie like setLocale does, and keeps the current search + hash.
 */
export function switchLocale(newLocale: string): void {
  const base = getAppBasePath();
  const pathname = window.location.pathname;
  const stripped =
    base && pathname.startsWith(base)
      ? pathname.slice(base.length) || '/'
      : pathname;
  // Cookie only — reload:false skips setLocale's own (base-blind) navigation.
  setLocale(newLocale as any, { reload: false });
  window.location.assign(
    `${withAppBase(localizeHref(stripped, { locale: newLocale as any }))}${window.location.search}${window.location.hash}`
  );
}
