import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Isolated database; no application modules load before the env is set.
// Mirrors tests/atomic.test.ts (SQLite batch path only).
const directory = await mkdtemp(join(tmpdir(), 'shipany-draft-preview-test-'));
Object.assign(process.env, {
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: `file:${join(directory, 'test.db')}`,
  AUTH_SECRET: 'test-secret-do-not-use-in-production-0123456789',
  NODE_ENV: 'test',
  VITE_APP_URL: 'http://localhost:3000',
});
execFileSync(
  process.execPath,
  [
    'node_modules/drizzle-kit/bin.cjs',
    'push',
    '--dialect=sqlite',
    '--schema=./src/config/db/schema.sqlite.ts',
    `--url=${process.env.DATABASE_URL}`,
    '--force',
  ],
  { stdio: 'pipe', env: process.env }
);

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

const { db } = await import('@/core/db');
const { post, user } = await import('@/config/db/schema');
const { getUuid } = await import('@/lib/hash');
const postsService = await import('@/modules/posts/service');

// post.userId references user.id (FK enforced) — seed one author row.
const authorId = getUuid();
await db().insert(user).values({
  id: authorId,
  name: 'Test Author',
  email: 'author@example.com',
});

async function insertPost(slug: string, status: string) {
  const id = getUuid();
  await db()
    .insert(post)
    .values({
      id,
      userId: authorId,
      slug,
      type: 'article',
      title: `Test ${slug}`,
      content: 'test content',
      status,
    });
  return id;
}

test('findBySlug finds a draft with a mixed-case slug (external-loader rows)', async () => {
  const slug = 'kb-draft-rules-01GBVQ3TEST1';
  await insertPost(slug, 'draft');
  const byMixed = await postsService.findBySlug(slug);
  assert.ok(byMixed, 'draft should be found by its own slug');
  assert.equal(byMixed.slug, slug);
  const byLower = await postsService.findBySlug(slug.toLowerCase());
  assert.ok(byLower, 'draft should be found by a lowercased slug');
  assert.equal(byLower.id, byMixed.id);
  const published = await postsService.findPublishedBySlug(slug);
  assert.equal(
    published,
    undefined,
    'draft must not match the published lookup'
  );
});

test('findPublishedBySlug finds a published post regardless of slug case', async () => {
  const slug = 'Course-ABC123';
  await insertPost(slug, 'published');
  const found = await postsService.findPublishedBySlug(slug.toLowerCase());
  assert.ok(found, 'published post should be found by a lowercased slug');
  assert.equal(found.slug, slug);
});

test('both lookups return undefined for an unknown slug', async () => {
  assert.equal(await postsService.findBySlug('no-such-slug'), undefined);
  assert.equal(
    await postsService.findPublishedBySlug('no-such-slug'),
    undefined
  );
});
