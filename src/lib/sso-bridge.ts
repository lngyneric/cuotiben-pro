// Client-side wiki -> ai-shifu SSO bridge.
//
// After a fresh wiki sign-in the user should end up logged into ai-shifu
// too. Two ways to hop, tried in order by the sign-in handler:
//
//   1. bridgeViaFetch — silent same-origin fetch of the ai-shifu SSO URL.
//      ai-shifu sets its `token` cookie on the 302 and redirects back to
//      the wiki destination; we follow the redirect and discard the body
//      instead of rendering it. No full-page hop, so a slow/stuck hop fails
//      fast (8 s cap) instead of leaving the button spinning.
//   2. bridgeToAiShifu — the original full-page navigation fallback.
//
// The SSO URL is minted once (GET /api/auth/sso) and shared by both
// attempts: that endpoint is rate-limited to one mint per 2 s per employee,
// so minting twice in a row would 429 the fallback. The 10-minute
// sessionStorage guard is owned by the caller (cleared before a fresh
// sign-in attempt); bridgeToAiShifu sets it when it actually navigates.
//
// Loop guard: the bridge runs at most once per login, and at most once
// every 10 minutes in the same tab (sessionStorage). The sign-in success
// handler is the only caller, so this is belt-and-braces — it mainly
// covers a double submit / double invoke of the handler.

import { apiGet } from '@/lib/api-client';

const SSO_BRIDGED_KEY = 'sso-bridged-at';
/** Skip the bridge if one already ran within this window (same tab). */
const SSO_BRIDGE_MIN_INTERVAL_MS = 10 * 60 * 1000;
/** Silent fetch bridge must fail fast instead of spinning the button. */
const FETCH_BRIDGE_TIMEOUT_MS = 8 * 1000;

/**
 * Clear the bridge loop guard so the next sign-in can hop through ai-shifu
 * again even if one ran within the last 10 minutes (re-verification after a
 * sync failure). Called from the sign-in success handler before bridging.
 */
export function clearSsoBridgeGuard(): void {
  try {
    sessionStorage.removeItem(SSO_BRIDGED_KEY);
  } catch {
    // Storage unavailable — the guard just stays as it was.
  }
}

/**
 * Mint the ai-shifu SSO URL once (GET /api/auth/sso?next=...). Returns null
 * when the bridge is unavailable (no session, not an AAD user, SSO not
 * configured, rate-limited). The caller reuses the returned URL for both
 * bridge attempts instead of minting twice.
 */
export async function fetchSsoUrl(next: string): Promise<string | null> {
  try {
    const { ssoUrl } = await apiGet<{ ssoUrl: string }>(
      `/api/auth/sso?next=${encodeURIComponent(next)}`
    );
    return ssoUrl || null;
  } catch (error) {
    console.error('[sso] mint sso url failed:', error);
    return null;
  }
}

/**
 * Silent bridge hop: fetch the ai-shifu SSO URL with credentials included.
 * Same origin (eu.sysmex.com.cn), so the `token` cookie ai-shifu sets on
 * its 302 is stored by the browser; the redirect is followed and the body
 * discarded, nothing is rendered. Returns true when the request completed
 * (any HTTP status — the caller verifies with checkAiShifuLogin), false
 * when it could not even be attempted or timed out.
 */
export async function bridgeViaFetch(
  next: string,
  ssoUrl?: string | null
): Promise<boolean> {
  try {
    const url = ssoUrl ?? (await fetchSsoUrl(next));
    if (!url) return false;
    const res = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_BRIDGE_TIMEOUT_MS),
    });
    // Consume and drop the body (the wiki destination page); never render it.
    await res.arrayBuffer().catch(() => null);
    return true;
  } catch (error) {
    console.error('[sso] fetch bridge failed:', error);
    return false;
  }
}

/**
 * Full-page bridge hop for `next` (the wiki page the user was heading to,
 * an internal path such as `/settings`). Returns true if the browser was
 * sent to ai-shifu (the caller must not navigate anywhere else); false if
 * the bridge was skipped or failed. Pass a pre-minted `ssoUrl` (from
 * fetchSsoUrl) to avoid a second mint inside the 2 s rate-limit window.
 */
export async function bridgeToAiShifu(
  next: string,
  ssoUrl?: string | null
): Promise<boolean> {
  try {
    const bridgedAt = Number(sessionStorage.getItem(SSO_BRIDGED_KEY) || '0');
    if (bridgedAt && Date.now() - bridgedAt < SSO_BRIDGE_MIN_INTERVAL_MS) {
      return false;
    }
    const url = ssoUrl ?? (await fetchSsoUrl(next));
    if (!url) return false;
    sessionStorage.setItem(SSO_BRIDGED_KEY, String(Date.now()));
    window.location.assign(url);
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
