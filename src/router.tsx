import { createRouter } from '@tanstack/react-router';

import { getAppBasePath } from '@/lib/base-path';
import { deLocalizeUrl, localizeUrl } from '@/paraglide/runtime.js';

import { routeTree } from './routeTree.gen';

export function getRouter() {
  // Sub-path mount (intranet /wiki): the router strips the basepath BEFORE
  // the locale rewrite runs on input, and re-adds it AFTER localizeUrl on
  // output (router-core composeRewrites: basepath first, then user rewrite).
  // So Paraglide's urlPatterns stay written against root-relative paths.
  const basepath = getAppBasePath() || '/';
  const router = createRouter({
    routeTree,
    basepath,
    defaultPreload: 'intent',
    scrollRestoration: true,
    // Paraglide owns locale prefixes: incoming URLs are de-localized before
    // matching (routes are locale-free), outgoing hrefs get re-localized.
    rewrite: {
      input: ({ url }) => deLocalizeUrl(url),
      output: ({ url }) => localizeUrl(url),
    },
  });
  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
