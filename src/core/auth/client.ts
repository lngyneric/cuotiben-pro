import { oneTapClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

import { getAppBasePath } from '@/lib/base-path';

// The auth endpoints live under the app base path too (`/wiki/api/auth/...`
// on the intranet build). `window.location.origin` alone would drop the
// `/wiki` prefix and send auth calls to the ai-shifu site on the same host.
// Server-side there is no window: VITE_APP_URL already carries the base
// path when the intranet build sets it, so use it as-is.
const baseURL =
  typeof window !== 'undefined'
    ? `${window.location.origin}${getAppBasePath()}`
    : import.meta.env?.VITE_APP_URL || 'http://localhost:3000';

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
