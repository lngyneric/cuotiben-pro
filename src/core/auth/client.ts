import { oneTapClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

import { getAppBasePath } from '@/lib/base-path';

// The auth endpoints live under the app base path too (`/wiki/api/auth/...`
// on the intranet build). `window.location.origin` alone would drop the
// `/wiki` prefix and send auth calls to the ai-shifu site on the same host.
// Server-side there is no window: VITE_APP_URL already carries the base
// path when the intranet build sets it, so use it as-is.
//
// The `/api/auth` suffix is REQUIRED, not cosmetic: better-auth's client
// resolves baseURL with `withPath`, which returns the URL unchanged when it
// already has a path — so `https://host/wiki` does NOT get `/api/auth`
// appended, and useSession() ends up calling `/wiki/get-session` (404).
// That 404 made every guarded page bounce back to sign-in right after a
// successful AAD login (the session cookie was fine all along). Passing the
// full auth URL (`…/wiki/api/auth`) makes the client call
// `/wiki/api/auth/get-session`, which the server route resolves.
const baseURL =
  typeof window !== 'undefined'
    ? `${window.location.origin}${getAppBasePath()}/api/auth`
    : `${(import.meta.env?.VITE_APP_URL || 'http://localhost:3000').replace(/\/$/, '')}/api/auth`;

export const authClient = createAuthClient({ baseURL });

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  requestPasswordReset,
  resetPassword,
} = authClient;

// Build a per-call auth client with the Google One Tap plugin attached.
// The plugin needs the client_id at construction time, so we can't add
// it to the default `authClient` — callers must pass live configs.
export function getAuthClient(configs: Record<string, string>) {
  return createAuthClient({
    baseURL,
    plugins:
      configs.google_client_id && configs.google_one_tap_enabled === 'true'
        ? [
            oneTapClient({
              clientId: configs.google_client_id,
              autoSelect: false,
              cancelOnTapOutside: false,
              context: 'signin',
              promptOptions: {
                baseDelay: 1000,
                maxAttempts: 1,
              },
            }),
          ]
        : [],
  });
}
