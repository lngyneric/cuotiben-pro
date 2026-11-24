// Wiki -> ai-shifu SSO bridge (server side).
//
// After a wiki login, the browser is sent through ai-shifu's SSO endpoint
// (`/api/user/sso`) carrying a short-lived signed JWT; ai-shifu verifies
// the signature, sets its own `token` cookie, and redirects back to the
// wiki — so one wiki login leaves the user signed in on both systems.
//
// This module holds no secrets itself: the HMAC key comes from env
// (SSO_SHARED_SECRET) via envConfigs, and the JWT is minted with Node's
// built-in crypto (no new dependency — the repo has no JWT library).
// Only the route (src/routes/api/auth/sso.ts) calls into this module.

import { createHmac, randomUUID } from 'node:crypto';

import { envConfigs } from '@/config';
import { safeInternalPath } from '@/lib/redirect';

/** ai-shifu SSO endpoint (production). */
export const AISHIFU_SSO_URL = 'https://eu.sysmex.com.cn/api/user/sso';

/** Issuer / audience stamped on the bridge JWT. */
export const SSO_JWT_ISSUER = 'wiki';
export const SSO_JWT_AUDIENCE = 'ai-shifu';

/** Bridge JWT lifetime (seconds). Short on purpose: a single login hop. */
export const SSO_JWT_TTL_SECONDS = 60;

/** Synthetic-email domain that keys AAD-created wiki users. */
export const AAD_EMAIL_DOMAIN = 'sysmex.internal';

/**
 * Derive the ai-shifu employee number from a wiki user's email.
 *
 * AAD-created wiki users are keyed by the synthetic email
 * `<employeeNo>@sysmex.internal` (see src/modules/aad/service.ts:
 * `aadEmployeeEmail` — the employee number is trimmed and lowercased
 * before the domain is appended). Returns the lowercased employee number,
 * or null when the email is not an AAD user email.
 */
export function deriveEmployeeNo(
  email: string | null | undefined
): string | null {
  if (!email) return null;
  const match = email.trim().match(/^([^@\s]+)@sysmex\.internal$/i);
  if (!match) return null;
  return match[1].toLowerCase();
}

function base64url(input: string | Buffer): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64url');
}

/**
 * Mint the bridge JWT (HS256, HMAC-SHA256 with the shared secret).
 *
 * Claims: iss "wiki", aud "ai-shifu", sub = employee number (lowercased),
 * iat now, exp now + 60 s, jti a random uuid (single-use binding on the
 * ai-shifu side). `name` (the AAD display name from the wiki session) is
 * included when available so ai-shifu can record it in the user's profile
 * on first bridge login instead of asking for it in a course; it is
 * optional and older tokens without it still verify.
 */
export function mintSsoJwt(
  secret: string,
  employeeNo: string,
  name?: string | null
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const trimmedName = (name || '').trim();
  const payload = base64url(
    JSON.stringify({
      iss: SSO_JWT_ISSUER,
      aud: SSO_JWT_AUDIENCE,
      sub: employeeNo.toLowerCase(),
      ...(trimmedName ? { name: trimmedName } : {}),
      iat: now,
      exp: now + SSO_JWT_TTL_SECONDS,
      jti: randomUUID(),
    })
  );
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/**
 * Build the absolute wiki URL the browser should land on after ai-shifu
 * sets its cookie.
 *
 * `next` is the wiki page the user was heading to: an internal path (such
 * as `/settings`, locale-free) or an absolute URL on the wiki origin.
 * Anything that is not a safe internal path, not on the wiki origin, or
 * pointing at an auth page falls back to the wiki home — never an open
 * redirect. A leading app-base prefix (e.g. `/wiki/settings`) is tolerated
 * and stripped, since the absolute URL is rebuilt from `app_url`.
 */
export function buildWikiDestination(next: string | null | undefined): string {
  const appUrl = (envConfigs.app_url || 'http://localhost:3000').replace(
    /\/$/,
    ''
  );
  const home = `${appUrl}/`;
  if (!next) return home;

  let origin: string;
  let basePath: string;
  try {
    const parsed = new URL(appUrl);
    origin = parsed.origin;
    basePath = parsed.pathname.replace(/\/$/, '');
  } catch {
    return home;
  }

  const raw = String(next).trim();

  // Absolute URL: must be on the wiki origin and under the base path.
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.origin !== origin) return home;
      const path = url.pathname;
      if (basePath && !(path === basePath || path.startsWith(`${basePath}/`))) {
        return home;
      }
      const internal = basePath ? path.slice(basePath.length) || '/' : path;
      const safe = safeInternalPath(internal);
      if (!safe) return home;
      return `${appUrl}${safe}${url.search}${url.hash}`;
    } catch {
      return home;
    }
  }

  // Internal path: must be a safe internal path (never an auth page).
  const safe = safeInternalPath(raw);
  if (!safe) return home;
  let internal = safe;
  if (
    basePath &&
    (internal === basePath || internal.startsWith(`${basePath}/`))
  ) {
    internal = internal.slice(basePath.length) || '/';
  }
  return `${appUrl}${internal}`;
}

/** Build the full ai-shifu SSO URL for one bridge hop. */
export function buildSsoUrl(token: string, next: string): string {
  return (
    `${AISHIFU_SSO_URL}?token=${encodeURIComponent(token)}` +
    `&next=${encodeURIComponent(next)}`
  );
}
