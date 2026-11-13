// Client-side wiki -> ai-shifu SSO bridge hop.
//
// Called once right after a fresh wiki sign-in. Fetches the ai-shifu SSO
// URL from GET /api/auth/sso and navigates the browser there; ai-shifu
// sets its own cookie and redirects back to the wiki destination. Never
// blocks login: any failure just returns false and the caller proceeds to
// the normal post-login destination.
//
// Loop guard: the bridge runs at most once per login, and at most once
// every 10 minutes in the same tab (sessionStorage). The sign-in success
// handler is the only caller, so this is belt-and-braces — it mainly
// covers a double submit / double invoke of the handler.

import { apiGet } from '@/lib/api-client';

const SSO_BRIDGED_KEY = 'sso-bridged-at';
/** Skip the bridge if one already ran within this window (same tab). */
const SSO_BRIDGE_MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Attempt the ai-shifu bridge hop for `next` (the wiki page the user was
 * heading to, an internal path such as `/settings`). Returns true if the
 * browser was sent to ai-shifu (the caller must not navigate anywhere
 * else); false if the bridge was skipped or failed (the caller should go
 * to the normal destination).
 */
export async function bridgeToAiShifu(next: string): Promise<boolean> {
  try {
    const bridgedAt = Number(sessionStorage.getItem(SSO_BRIDGED_KEY) || '0');
    if (bridgedAt && Date.now() - bridgedAt < SSO_BRIDGE_MIN_INTERVAL_MS) {
      return false;
    }
    const { ssoUrl } = await apiGet<{ ssoUrl: string }>(
      `/api/auth/sso?next=${encodeURIComponent(next)}`
    );
    if (!ssoUrl) return false;
    sessionStorage.setItem(SSO_BRIDGED_KEY, String(Date.now()));
    window.location.assign(ssoUrl);
    // If the navigation commits, this page unloads and we never return.
    // If we're still here after a short delay, the navigation didn't
    // happen — report failure so the caller goes to the normal destination.
    await new Promise((resolve) => setTimeout(resolve, 800));
    return false;
  } catch (error) {
    console.error('[sso] ai-shifu bridge failed, continuing to wiki:', error);
    return false;
  }
}
