// Wiki + ai-shifu login-sync checks (intranet/AAD builds only).
//
// The wiki session lives in better-auth (`/api/user/info` on this app,
// reached through api-client so the /wiki base path is applied), while the
// ai-shifu session is a plain same-origin `GET /api/user/info` — that call
// must NOT go through api-client/withAppBase, or it would land on
// /wiki/api/... (this app) instead of ai-shifu. Any non-zero code, non-JSON
// body or fetch failure counts as "not logged in" on either side.

import { apiGet } from '@/lib/api-client';

export interface LoginSyncStatus {
  wiki: boolean;
  aishifu: boolean;
  synced: boolean;
}

/** Set on sign-in success; the homepage shows the success banner once. */
export const LOGIN_JUST_SUCCEEDED_KEY = 'login-just-succeeded';
/** When the homepage bounced to sign-in for a sync failure, remember it so
 *  a still-unsynced return within this window shows a banner instead of
 *  bouncing again. */
export const SYNC_FAILED_AT_KEY = 'login-sync-failed-at';
export const SYNC_FAILED_WINDOW_MS = 60 * 1000;

function sessionGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode, SSR) — the banners just won't show.
  }
}

function sessionRemove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Ignore — see sessionSet.
  }
}

/** Wiki login state: apiGet throws unless /api/user/info returns code 0. */
export async function checkWikiLogin(): Promise<boolean> {
  try {
    await apiGet('/api/user/info');
    return true;
  } catch {
    return false;
  }
}

/** ai-shifu login state: HTTP 200 + {"code": 0} only; code 1001 (and
 *  anything else) means not logged in. */
export async function checkAiShifuLogin(): Promise<boolean> {
  try {
    const res = await fetch('/api/user/info', { credentials: 'include' });
    const json = await res.json().catch(() => null);
    return !!json && json.code === 0;
  } catch {
    return false;
  }
}

export async function checkLoginSync(): Promise<LoginSyncStatus> {
  const [wiki, aishifu] = await Promise.all([
    checkWikiLogin(),
    checkAiShifuLogin(),
  ]);
  return { wiki, aishifu, synced: wiki && aishifu };
}

/** Mark a fresh sign-in so the homepage can show the success banner. */
export function markLoginJustSucceeded(): void {
  sessionSet(LOGIN_JUST_SUCCEEDED_KEY, '1');
}

/** Consume the success mark (true once, then it is gone). */
export function takeLoginJustSucceeded(): boolean {
  if (!sessionGet(LOGIN_JUST_SUCCEEDED_KEY)) return false;
  sessionRemove(LOGIN_JUST_SUCCEEDED_KEY);
  return true;
}

/** Record that the homepage bounced to sign-in over a sync failure. */
export function recordSyncFailure(): void {
  sessionSet(SYNC_FAILED_AT_KEY, String(Date.now()));
}

/** True if a sync-failure bounce happened within the last minute. */
export function hasRecentSyncFailure(): boolean {
  const at = Number(sessionGet(SYNC_FAILED_AT_KEY) || '0');
  return !!at && Date.now() - at < SYNC_FAILED_WINDOW_MS;
}

/** Clear the bounce record (fresh sign-in: the bridge gets another chance). */
export function clearSyncFailure(): void {
  sessionRemove(SYNC_FAILED_AT_KEY);
}
