// App base path — the sub-path the whole app is mounted under, e.g. `/wiki`
// behind the intranet nginx (`https://eu.sysmex.com.cn/wiki/`).
//
// Two sources, in priority order:
// 1. Vite `base` (build time): `import.meta.env.BASE_URL` is statically
//    inlined by Vite into both client and server bundles, so the value baked
//    into the build wins. `APP_BASE_PATH` must therefore be set when the
//    intranet image is built, not only at runtime.
// 2. `APP_BASE_PATH` env at runtime (server): covers the Nitro server bundle
//    if the Vite-inlined value is ever unavailable.
//
// Empty string = served at the domain root (Cloudflare default). Never
// returns a trailing slash; use `withAppBase()` to prefix paths.

export function getAppBasePath(): string {
  const viteBase =
    typeof import.meta !== 'undefined' && (import.meta as any).env?.BASE_URL
      ? String((import.meta as any).env.BASE_URL)
      : '';
  if (viteBase && viteBase !== '/') return viteBase.replace(/\/$/, '');
  if (typeof process !== 'undefined' && process.env?.APP_BASE_PATH) {
    const raw = process.env.APP_BASE_PATH.trim();
    if (raw && raw !== '/') {
      return (raw.startsWith('/') ? raw : `/${raw}`).replace(/\/$/, '');
    }
  }
  return '';
}

/**
 * Prefix an absolute same-origin path with the app base path:
 * `withAppBase('/api/blog/html')` → `/wiki/api/blog/html` on the intranet
 * build, `/api/blog/html` on the Cloudflare build. Relative URLs, absolute
 * URLs and non-`/` paths pass through unchanged.
 *
 * Use this for every hand-built URL that bypasses the TanStack router
 * (api-client, raw fetch calls, `window.location.assign`, better-auth
 * callback URLs). Router `<Link>` / `router.navigate()` already prepend the
 * basepath via the router rewrite — do not double-prefix those.
 */
export function withAppBase(path: string): string {
  if (!path.startsWith('/')) return path;
  const base = getAppBasePath();
  return base ? `${base}${path}` : path;
}
