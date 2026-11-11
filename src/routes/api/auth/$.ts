import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { getDbConfigs } from '@/modules/config/service';
import { getAppBasePath } from '@/lib/base-path';

// better-auth catch-all — the handler takes a standard Request and
// returns a standard Response, so it mounts directly.
//
// Sub-path fix: better-auth derives its router base path from the
// pathname of `baseURL` (the app URL — `/wiki` on the intranet build),
// so it expects endpoints at `<base>/get-session`. But the client calls
// `<base>/api/auth/get-session` (baseURL + `/api/auth`), and this route
// is mounted at `/api/auth/*`. Without the rewrite the router strips
// only `<base>` and looks up `/api/auth/get-session`, which matches no
// endpoint → 404. That made `useSession()` always return null, so every
// guarded page (AppLayout) bounced to sign-in right after a successful
// AAD login — the login loop. Strip the `/api/auth` mount segment (only
// when a base path is set; at the domain root the default `/api/auth`
// base path already matches) before handing the request to better-auth.
// `baseURL` itself is left untouched, so callback / verification URLs
// keep the plain app URL.
async function handle(request: Request) {
  const configs = await getDbConfigs();
  const auth = getAuth(configs);
  const base = getAppBasePath();
  if (base) {
    const url = new URL(request.url);
    const prefix = `${base}/api/auth`;
    if (url.pathname === prefix) {
      url.pathname = base;
    } else if (url.pathname.startsWith(`${prefix}/`)) {
      url.pathname = base + url.pathname.slice(prefix.length);
    } else {
      return auth.handler(request);
    }
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer();
    }
    return auth.handler(new Request(url, init));
  }
  return auth.handler(request);
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
});
