import assert from 'node:assert/strict';
import { test } from 'node:test';

// The blog-html service imports the RBAC service (which loads config/db),
// so set the env before importing any application module — same pattern as
// tests/atomic.test.ts. These tests only exercise the pure functions
// (sanitize + visibility rules) and never touch the database.
Object.assign(process.env, {
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: 'file::memory:',
  AUTH_SECRET: 'test-only-secret',
});

const { sanitizeBlogHtml, canViewBlogHtml, canManageBlogHtml } =
  await import('@/modules/blog-html/service');

const meta = (over: Record<string, unknown> = {}) => ({
  key: 'html/test.html',
  title: 't',
  description: '',
  category: '未分类',
  visibility: 'all',
  uploaderId: 'user-1',
  uploaderEmployeeNo: 'test001',
  sha256: '',
  size: 0,
  uploaded: new Date().toISOString(),
  url: '/api/blog/html/html%2Ftest.html',
  ...over,
});

test('sanitizeBlogHtml strips active content but keeps benign markup', () => {
  const dirty = [
    '<script>alert(1)</script>',
    '<SCRIPT SRC="https://evil.example/x.js"></SCRIPT>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="x.swf"></object><embed src="x.swf">',
    '<base href="https://evil.example/">',
    '<form action="https://evil.example"><input></form>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<p onclick="alert(1)">a</p>',
    `<p onload='alert(2)'>b</p>`,
    '<a href="javascript:alert(3)">c</a>',
    '<a href="  JaVaScRiPt:alert(4)">d</a>',
    '<a href="vbscript:msgbox(1)">e</a>',
    '<a href="data:text/html,<script>alert(5)</script>">f</a>',
    '<p style="width: expression(alert(6))">g</p>',
    '<p style="x: expression(alert(7))">h</p>',
  ].join('\n');
  const clean = sanitizeBlogHtml(dirty);
  for (const bad of [
    '<script',
    '<iframe',
    '<object',
    '<embed',
    '<base',
    '<form',
    'http-equiv',
    'onclick',
    'onload',
    'javascript:',
    'vbscript:',
    'data:text/html',
    'expression(',
    'alert(',
  ]) {
    assert.ok(!clean.toLowerCase().includes(bad), `leaked: ${bad}`);
  }
  // Link text and document structure survive (href neutralized to #).
  assert.ok(clean.includes('>c</a>'));
  assert.ok(clean.includes('href="#"'));

  const benign =
    '<style>p{color:red}</style><p style="color: blue">x</p>' +
    '<img src="https://ok.example/a.png"><a href="https://ok.example">ok</a>' +
    '<img src="data:image/png;base64,iVBORw0KGgo=">' +
    '<table><tr><td>1</td></tr></table>';
  const kept = sanitizeBlogHtml(benign);
  assert.equal(kept, benign);
});

test('canViewBlogHtml: all is public, self is owner/admin only', () => {
  assert.equal(canViewBlogHtml(meta(), null), true);
  assert.equal(canViewBlogHtml(meta({ visibility: 'self' }), null), false);
  assert.equal(
    canViewBlogHtml(meta({ visibility: 'self' }), {
      userId: 'user-1',
      isAdmin: false,
    }),
    true
  );
  assert.equal(
    canViewBlogHtml(meta({ visibility: 'self' }), {
      userId: 'user-2',
      isAdmin: false,
    }),
    false
  );
  assert.equal(
    canViewBlogHtml(meta({ visibility: 'self' }), {
      userId: 'user-2',
      isAdmin: true,
    }),
    true
  );
  // A self item with no recorded uploader is visible to nobody but admins.
  assert.equal(
    canViewBlogHtml(meta({ visibility: 'self', uploaderId: null }), {
      userId: 'user-2',
      isAdmin: false,
    }),
    false
  );
});

test('canManageBlogHtml: owner or admin; legacy no-uploader stays open', () => {
  assert.equal(
    canManageBlogHtml(meta(), { userId: 'user-1', isAdmin: false }),
    true
  );
  assert.equal(
    canManageBlogHtml(meta(), { userId: 'user-2', isAdmin: false }),
    false
  );
  assert.equal(
    canManageBlogHtml(meta(), { userId: 'user-2', isAdmin: true }),
    true
  );
  assert.equal(
    canManageBlogHtml(meta({ uploaderId: null }), {
      userId: 'user-2',
      isAdmin: false,
    }),
    true
  );
});
