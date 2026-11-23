import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';

// Regression test for 2026-11-22: a `pnpm rbac:init` run during the mentoring
// dashboard deploy wiped the literal `admin.*` row from the admin role
// (the seed never listed it), so hasPermission(user, 'admin.*') returned
// false and /admin redirected to /settings. The seed must keep the literal
// `admin.*` row, granted literally (not expanded), so a future rbac:init
// cannot wipe it again -- and the expansion must not hand out the two
// super_admin-only codes (admin.passwords.reset, admin.payments.refund).

const directory = await mkdtemp(join(tmpdir(), 'shipany-rbac-seed-test-'));
const dbFile = join(directory, 'test.db');
const dbUrl = 'file:' + dbFile;
Object.assign(process.env, {
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: dbUrl,
  AUTH_SECRET: 'test-secret',
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
    '--url=' + dbUrl,
    '--force',
  ],
  { stdio: 'pipe', env: process.env }
);

const { db } = await import('../src/core/db');
const { permission, role, rolePermission } =
  await import('../src/config/db/schema');

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

function runRbacInit() {
  execFileSync(
    join(process.cwd(), 'node_modules', '.bin', 'tsx'),
    ['scripts/init-rbac.ts'],
    { stdio: 'pipe', env: process.env }
  );
}

async function adminCodes(): Promise<string[]> {
  const rows = await db()
    .select({ code: permission.code })
    .from(rolePermission)
    .innerJoin(role, eq(rolePermission.roleId, role.id))
    .innerJoin(permission, eq(rolePermission.permissionId, permission.id))
    .where(eq(role.name, 'admin'))
    .orderBy(permission.code);
  return rows.map((r) => r.code);
}

test('rbac:init seeds the literal admin.* row for the admin role', async () => {
  runRbacInit();
  const codes = await adminCodes();
  assert.equal(codes.length, 26);
  assert.ok(codes.includes('admin.*'), 'admin role must hold literal admin.*');
  assert.ok(
    codes.includes('admin.mentoring_dashboard.read'),
    'admin role must hold the dashboard read code'
  );
  assert.ok(
    !codes.includes('admin.passwords.reset'),
    'admin role must not hold passwords.reset explicitly'
  );
  assert.ok(
    !codes.includes('admin.payments.refund'),
    'admin role must not hold payments.refund explicitly'
  );
});

test('a second rbac:init run keeps the literal admin.* row', async () => {
  // Simulate the 2026-11-22 recurrence: a later deploy runs rbac:init again.
  runRbacInit();
  const codes = await adminCodes();
  assert.equal(codes.length, 26);
  assert.ok(codes.includes('admin.*'), 'admin.* must survive a re-seed');
  assert.ok(
    !codes.includes('admin.passwords.reset'),
    'passwords.reset must stay out after a re-seed'
  );
  assert.ok(
    !codes.includes('admin.payments.refund'),
    'payments.refund must stay out after a re-seed'
  );
});
