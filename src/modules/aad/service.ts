// Internal enterprise AAD login.
//
// The "AAD" here is the company's INTERNAL AAD server
// (10.40.20.195:8082) — it is NOT Microsoft Entra ID, so better-auth's
// Microsoft / generic-OAuth providers cannot be used for it. Login is a
// server-side employee-number + password check against that server, exactly like
// ai-shifu's employee provider
// (~/workspace/ai-coach/src/api/flaskr/service/user/auth/providers/employee.py).
//
// Rules carried over from ai-shifu (11-10 lessons):
// - A wrong password and an unreachable AAD server are DIFFERENT failures
//   and must be reported differently (ai-shifu used to conflate both into
//   code 1016 "password wrong").
// - The AAD password is never logged and never stored. It travels only in
//   the single outbound AAD request (base64 in the query string, which is
//   the AAD server's own API shape) and is dropped afterwards.
// - A verified employee is auto-registered on first login: the local user
//   is keyed by the synthetic email `{employeeNo}@sysmex.internal` and
//   marked verified. No local password is ever created for these users —
//   the AAD server stays the only password authority.
// - Node's fetch does not read proxy env vars, so the AAD call always goes
//   direct; NO_PROXY including 10.40.20.195 is still documented in
//   .env.intranet.example for curl/debugging and any proxy-aware tooling.
//
// Session issuance: better-auth 1.7 has no public "sign in by user id"
// endpoint, so the session is created through `auth.$context` +
// `internalAdapter.createSession` (the same call its own sign-in route
// makes) and the session cookie is written with the exact format
// better-auth itself uses: the cookie value is
// `encodeURIComponent(token + "." + base64(HMAC-SHA256(secret, token)))`,
// the cookie name/attributes come from `authCtx.authCookies.sessionToken`
// (so the `__Secure-` prefix, Path, HttpOnly, SameSite and Max-Age always
// match what `auth.api.getSession` expects). Only the `session_token`
// cookie is set — the `session_data` cache cookie is optional; without it
// `getSession` falls back to a database lookup.

import { eq } from 'drizzle-orm';

import { getAuth } from '@/core/auth';
import { db } from '@/core/db';
import { envConfigs } from '@/config';
import { user } from '@/config/db/schema';
import { getAllConfigs } from '@/modules/config/service';
import { grantForNewUser } from '@/modules/credits/service';
import { grantRoleForNewUser } from '@/modules/rbac/service';
import { getUuid } from '@/lib/hash';

export type AadVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_credentials' | 'aad_unavailable' };

/** Synthetic email that keys an AAD employee's local user row. */
export function aadEmployeeEmail(employeeNo: string): string {
  return `${employeeNo.trim().toLowerCase()}@sysmex.internal`;
}

/**
 * Verify a worker number + password against the internal AAD server.
 * GET {AAD_AUTH_URL}/getAccessTokenByEmployeeNo?employeeNo=..&password=<base64>
 * with a 10 s timeout. HTTP 200 plus body `statusCode == "200"` or
 * `message == "success"` means the credentials are valid — note the AAD
 * server answers HTTP 200 even for a wrong password, so the body decides.
 */
export async function verifyAadEmployee(
  employeeNo: string,
  password: string
): Promise<AadVerifyResult> {
  const no = employeeNo.trim().toLowerCase();
  if (!no || !password) return { ok: false, reason: 'invalid_credentials' };

  const base = (envConfigs.aad_auth_url || 'http://10.40.20.195:8082').replace(
    /\/$/,
    ''
  );
  // The AAD API takes the password base64-encoded in the query string.
  // It is never written to any log: the catch below logs only the error
  // message, and the URL (with the credential) is never logged.
  const encodedPassword = Buffer.from(password, 'utf8').toString('base64');
  const url =
    `${base}/getAccessTokenByEmployeeNo` +
    `?employeeNo=${encodeURIComponent(no)}` +
    `&password=${encodeURIComponent(encodedPassword)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error(
      '[aad] AAD server unreachable:',
      error instanceof Error ? error.message : String(error)
    );
    return { ok: false, reason: 'aad_unavailable' };
  }

  if (res.status !== 200) return { ok: false, reason: 'invalid_credentials' };
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  if (String(body?.statusCode) === '200' || body?.message === 'success') {
    return { ok: true };
  }
  return { ok: false, reason: 'invalid_credentials' };
}

/**
 * Find the local user for an AAD employee, creating it on first login.
 * Mirrors better-auth's `user.create.after` hook (src/core/auth/index.ts)
 * so AAD-created users get the same default role / signup credits as
 * email sign-ups instead of silently missing them.
 */
export async function findOrCreateAadUser(employeeNo: string) {
  const no = employeeNo.trim().toLowerCase();
  const email = aadEmployeeEmail(no);
  const existing = await db().select().from(user).where(eq(user.email, email));
  if (existing[0]) return { user: existing[0], created: false };

  const id = getUuid();
  const now = new Date();
  await db().insert(user).values({
    id,
    name: no,
    email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });

  try {
    const configs = await getAllConfigs();
    await grantRoleForNewUser({ userId: id, configs });
    await grantForNewUser({ userId: id, userEmail: email, configs });
  } catch (error) {
    // Onboarding side effects must not fail the login itself.
    console.error('[aad] onboarding side effects failed:', error);
  }

  const created = await db().select().from(user).where(eq(user.id, id));
  if (!created[0]) throw new Error('Failed to create user');
  return { user: created[0], created: true };
}

/**
 * Create a better-auth session for an already-verified user and return the
 * `Set-Cookie` header value for it. The caller attaches it to the response
 * (the AAD route returns it via `respData(..., { headers })`).
 */
export async function createAadSessionCookie(userId: string): Promise<string> {
  const auth = getAuth();
  const authCtx = (await auth.$context) as any;
  const session = await authCtx.internalAdapter.createSession(userId);
  if (!session?.token) throw new Error('Failed to create session');

  // Sign exactly like better-auth's setSignedCookie (better-call):
  // value = encodeURIComponent(token + "." + base64(HMAC-SHA256(secret, token)))
  const { createHmac } = await import('node:crypto');
  const signature = createHmac('sha256', authCtx.secret as string)
    .update(session.token)
    .digest('base64');
  const value = encodeURIComponent(`${session.token}.${signature}`);

  const cookie = authCtx.authCookies.sessionToken as {
    name: string;
    attributes: Record<string, any>;
  };
  const attrs = cookie.attributes || {};
  const maxAge = authCtx.sessionConfig?.expiresIn ?? 60 * 60 * 24 * 7;
  const parts = [`${cookie.name}=${value}`, `Max-Age=${Math.floor(maxAge)}`];
  if (attrs.path) parts.push(`Path=${attrs.path}`);
  if (attrs.httpOnly) parts.push('HttpOnly');
  if (attrs.secure) parts.push('Secure');
  if (attrs.sameSite) {
    const s = String(attrs.sameSite);
    parts.push(`SameSite=${s.charAt(0).toUpperCase()}${s.slice(1)}`);
  }
  if (attrs.domain) parts.push(`Domain=${attrs.domain}`);
  return parts.join('; ');
}
