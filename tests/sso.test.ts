import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

// Env must be set before the service module is imported (envConfigs reads
// process.env at import time). Use dynamic import below.
Object.assign(process.env, {
  NODE_ENV: 'test',
  VITE_APP_URL: 'https://eu.sysmex.com.cn/wiki',
  SSO_SHARED_SECRET: 'test-only-sso-secret',
});

const {
  AISHIFU_SSO_URL,
  SSO_JWT_AUDIENCE,
  SSO_JWT_ISSUER,
  SSO_JWT_TTL_SECONDS,
  buildSsoUrl,
  buildWikiDestination,
  deriveEmployeeNo,
  mintSsoJwt,
} = await import('@/modules/sso/service');

function decodeJwtPart(part: string): any {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

test('deriveEmployeeNo: AAD synthetic email -> employee number', () => {
  assert.equal(deriveEmployeeNo('sch00068@sysmex.internal'), 'sch00068');
  assert.equal(deriveEmployeeNo('SCH00068@sysmex.internal'), 'sch00068');
  assert.equal(deriveEmployeeNo('  sch00068@sysmex.internal  '), 'sch00068');
});

test('deriveEmployeeNo: non-AAD email -> null', () => {
  assert.equal(deriveEmployeeNo('user@example.com'), null);
  assert.equal(deriveEmployeeNo('sch00068@sysmex.com.cn'), null);
  assert.equal(deriveEmployeeNo('sch00068@sysmex.internal.evil.com'), null);
  assert.equal(deriveEmployeeNo(null), null);
  assert.equal(deriveEmployeeNo(''), null);
});

test('mintSsoJwt: claims and HS256 signature', () => {
  const secret = 'test-only-sso-secret';
  const token = mintSsoJwt(secret, 'sch00068');
  const [headerPart, payloadPart, signaturePart] = token.split('.');
  assert.equal(decodeJwtPart(headerPart).alg, 'HS256');
  assert.equal(decodeJwtPart(headerPart).typ, 'JWT');

  const payload = decodeJwtPart(payloadPart);
  assert.equal(payload.iss, SSO_JWT_ISSUER);
  assert.equal(payload.aud, SSO_JWT_AUDIENCE);
  assert.equal(payload.sub, 'sch00068');
  assert.equal(payload.exp - payload.iat, SSO_JWT_TTL_SECONDS);
  assert.ok(Math.abs(payload.iat - Math.floor(Date.now() / 1000)) <= 5);
  assert.equal(typeof payload.jti, 'string');
  assert.ok(payload.jti.length > 0);

  // Signature verifies with the shared secret.
  const expected = createHmac('sha256', secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest('base64url');
  assert.equal(signaturePart, expected);

  // Wrong secret must not verify.
  const wrong = createHmac('sha256', 'another-secret')
    .update(`${headerPart}.${payloadPart}`)
    .digest('base64url');
  assert.notEqual(signaturePart, wrong);

  // Two mints differ (fresh jti / iat).
  assert.notEqual(token, mintSsoJwt(secret, 'sch00068'));
});

test('buildWikiDestination: internal paths, base prefix, and fallbacks', () => {
  // app_url is https://eu.sysmex.com.cn/wiki in this test env.
  assert.equal(
    buildWikiDestination('/settings'),
    'https://eu.sysmex.com.cn/wiki/settings'
  );
  assert.equal(
    buildWikiDestination('/wiki/settings'),
    'https://eu.sysmex.com.cn/wiki/settings'
  );
  assert.equal(buildWikiDestination(null), 'https://eu.sysmex.com.cn/wiki/');
  assert.equal(buildWikiDestination(''), 'https://eu.sysmex.com.cn/wiki/');
  assert.equal(
    buildWikiDestination('https://eu.sysmex.com.cn/wiki/settings?x=1'),
    'https://eu.sysmex.com.cn/wiki/settings?x=1'
  );
});

test('buildWikiDestination: open redirect and auth pages fall back home', () => {
  assert.equal(
    buildWikiDestination('https://evil.com/steal'),
    'https://eu.sysmex.com.cn/wiki/'
  );
  assert.equal(
    buildWikiDestination('//evil.com/steal'),
    'https://eu.sysmex.com.cn/wiki/'
  );
  assert.equal(
    buildWikiDestination('/sign-in'),
    'https://eu.sysmex.com.cn/wiki/'
  );
  assert.equal(
    buildWikiDestination('https://eu.sysmex.com.cn/sign-in'),
    'https://eu.sysmex.com.cn/wiki/'
  );
  assert.equal(
    buildWikiDestination('javascript:alert(1)'),
    'https://eu.sysmex.com.cn/wiki/'
  );
});

test('buildSsoUrl: ai-shifu endpoint with token and next', () => {
  const url = buildSsoUrl('tok123', 'https://eu.sysmex.com.cn/wiki/settings');
  assert.ok(url.startsWith(`${AISHIFU_SSO_URL}?`));
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('token'), 'tok123');
  assert.equal(
    parsed.searchParams.get('next'),
    'https://eu.sysmex.com.cn/wiki/settings'
  );
});
