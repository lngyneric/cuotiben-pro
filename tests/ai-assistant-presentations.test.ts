import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// Session-facing PPT route (/api/ai-assistant/presentations): the AI
// assistant page's entry to the production Presenton service. Same service
// as the MCP handlers, but the caller is a logged-in wiki user (or an agent
// key in tests — authenticateAdmin accepts both) and ownership is the
// (userId, tokenId) pair. Presenton is stubbed; the DB is a temp sqlite
// file, same setup as tests/presentations.test.ts.

// No application modules are loaded until the isolated environment is installed.
const directory = await mkdtemp(join(tmpdir(), 'shipany-aippt-test-'));
Object.assign(process.env, {
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: `file:${join(directory, 'test.db')}`,
  AUTH_SECRET: 'test-secret-aippt-0123456789abcdef',
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
const { db } = await import('../src/core/db');
const schema = await import('../src/config/db/schema');
const access = await import('../src/modules/admin-access/service');
const { saveConfigs } = await import('../src/modules/config/service');
const { Route: pptRoute } =
  await import('../src/routes/api/ai-assistant/presentations');
const { Route: downloadRoute } =
  await import('../src/routes/api/admin/agent/presentations/download');

const PPTX_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('fake-pptx-content'),
]);

// --- Stubbed Presenton (standard flow only; smart quota via createFail) ---
const stub = {
  mode: 'pending-then-completed' as
    | 'pending-then-completed'
    | 'error-quota'
    | 'pending',
  statusCalls: 0,
  createCalls: 0,
  createFail: 'none' as 'none' | 'quota-429',
};

function stubFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const body = typeof init?.body === 'string' ? init.body : '';
  void body;
  const json = (data: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  if (url.endsWith('/api/v1/ppt/presentation/generate/async'))
    return json({
      id: 'task-1',
      status: 'pending',
      data: {
        presentation_id: 'pres-1',
        created_slides: 0,
        remaining_slides: 1,
      },
    });
  if (url.includes('/api/v1/ppt/presentation/status/')) {
    stub.statusCalls += 1;
    if (stub.mode === 'error-quota')
      return json({
        id: 'task-1',
        status: 'error',
        message: 'Presentation generation failed',
        error: {
          detail:
            'Rate limit exceeded for model opencode-go/deepseek-v4.1-flash',
        },
        data: { presentation_id: 'pres-1' },
      });
    if (stub.mode === 'pending' || stub.statusCalls === 1)
      return json({
        id: 'task-1',
        status: 'pending',
        message: 'Generating',
        data: {
          presentation_id: 'pres-1',
          created_slides: 0,
          remaining_slides: 1,
        },
      });
    return json({
      id: 'task-1',
      status: 'completed',
      message: 'Presentation generation completed',
      data: {
        presentation_id: 'pres-1',
        created_slides: 1,
        remaining_slides: 0,
        path: '/app_data/exports/test.pptx',
        edit_path: '/presentation?id=pres-1',
      },
    });
  }
  if (url.endsWith('/api/v1/ppt/presentation/create')) {
    stub.createCalls += 1;
    if (stub.createFail === 'quota-429')
      return json(
        {
          detail:
            'Rate limit exceeded for model opencode-go/deepseek-v4.1-flash',
        },
        429
      );
    return json({ id: 'pres-smart', title: 'Smart Deck' });
  }
  if (url.endsWith('/api/v1/ppt/presentation/pres-1'))
    return json({ id: 'pres-1', title: 'Test Deck', slides: [{ id: 's1' }] });
  if (url.endsWith('/app_data/exports/test.pptx'))
    return Promise.resolve(new Response(PPTX_BYTES as unknown as BodyInit));
  return Promise.resolve(new Response('not found', { status: 404 }));
}

let ownerToken: string;
let otherToken: string;

before(async () => {
  globalThis.fetch = stubFetch as typeof fetch;
  await saveConfigs({
    presenton_base_url: 'http://presenton.test',
    presenton_api_key: 'test-key-1234567890',
  });
  await db()
    .insert(schema.permission)
    .values([
      {
        id: 'perm-gen',
        code: 'admin.presentations.generate',
        resource: 'presentations',
        action: 'generate',
        title: 'Generate PPT',
      },
      {
        id: 'perm-read',
        code: 'admin.presentations.read',
        resource: 'presentations',
        action: 'read',
        title: 'Read PPT jobs',
      },
    ]);
  await db()
    .insert(schema.role)
    .values([
      {
        id: 'role-owner',
        name: 'aippt-owner',
        title: 'AI PPT Owner',
        status: 'active',
      },
      {
        id: 'role-other',
        name: 'aippt-other',
        title: 'AI PPT Other',
        status: 'active',
      },
    ]);
  await db()
    .insert(schema.rolePermission)
    .values([
      { id: 'rp-gen', roleId: 'role-owner', permissionId: 'perm-gen' },
      { id: 'rp-read', roleId: 'role-owner', permissionId: 'perm-read' },
      { id: 'rp-read2', roleId: 'role-other', permissionId: 'perm-read' },
    ]);
  const owner = await access.createAgent({
    name: 'AI PPT owner agent',
    roleIds: ['role-owner'],
    operatorPermissions: ['*'],
  });
  ownerToken = (
    await access.createAgentKey({
      agentId: owner.id,
      name: 'Owner',
      expiresAt: null,
    })
  ).token;
  const other = await access.createAgent({
    name: 'AI PPT other agent',
    roleIds: ['role-other'],
    operatorPermissions: ['*'],
  });
  otherToken = (
    await access.createAgentKey({
      agentId: other.id,
      name: 'Other',
      expiresAt: null,
    })
  ).token;
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

// The route rate-limits per user (10s between creates) and per IP (200ms).
// Tests isolate from that on purpose — the limiter itself is covered by the
// dedicated rate-limit test below.
function clearRateLimits() {
  (globalThis as any).__minIntervalRateLimitStore?.clear();
}

type PptHandlers = {
  POST: (context: { request: Request }) => Promise<Response>;
  GET: (context: { request: Request }) => Promise<Response>;
};

function handlers(): PptHandlers {
  return pptRoute.options.server!.handlers as unknown as PptHandlers;
}

async function postPpt(
  input: Record<string, unknown>,
  token: string
): Promise<{ response: Response; body: any }> {
  clearRateLimits();
  const response = await handlers().POST({
    request: new Request('http://localhost/api/ai-assistant/presentations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    }),
  });
  return { response, body: (await response.json()) as any };
}

async function getPpt(
  id: string,
  token: string
): Promise<{ response: Response; body: any }> {
  clearRateLimits();
  const response = await handlers().GET({
    request: new Request(
      `http://localhost/api/ai-assistant/presentations?id=${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    ),
  });
  return { response, body: (await response.json()) as any };
}

test('POST without the generate permission → 403', async () => {
  const { response } = await postPpt({ content: 'x' }, otherToken);
  assert.equal(response.status, 403);
});

test('POST creates a job; owner polls it to completed and downloads it', async () => {
  stub.mode = 'pending-then-completed';
  stub.statusCalls = 0;
  const { response, body } = await postPpt(
    { content: 'Assistant deck topic', nSlides: 1 },
    ownerToken
  );
  assert.equal(response.status, 200);
  assert.equal(body.code, 0);
  const jobId = body.data.jobId as string;
  assert.equal(body.data.status, 'generating');

  const first = await getPpt(jobId, ownerToken);
  assert.equal(first.response.status, 200);
  assert.equal(first.body.data.status, 'generating');

  const got = await getPpt(jobId, ownerToken);
  assert.equal(got.response.status, 200);
  assert.equal(got.body.data.status, 'completed');
  assert.equal(got.body.data.slideCount, 1);
  assert.equal(got.body.data.title, 'Test Deck');
  assert.equal(
    got.body.data.downloadUrl,
    `/api/admin/agent/presentations/download?id=${jobId}`
  );

  const downloadHandlers = downloadRoute.options.server!.handlers as {
    GET: (context: { request: Request }) => Promise<Response>;
  };
  const file = await downloadHandlers.GET({
    request: new Request(
      `http://localhost/api/admin/agent/presentations/download?id=${encodeURIComponent(jobId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    ),
  });
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PPTX_BYTES);
});

test('non-owner GET → 404', async () => {
  stub.mode = 'pending';
  stub.statusCalls = 0;
  const { body } = await postPpt(
    { content: 'Ownership test', nSlides: 1 },
    ownerToken
  );
  const jobId = body.data.jobId as string;
  const foreign = await getPpt(jobId, otherToken);
  assert.equal(foreign.response.status, 404);
  assert.match(foreign.body.message, /not found/i);
});

test('completed job downloadUrl carries the /wiki app base when APP_BASE_PATH is set', async () => {
  // Regression: the page renders downloadUrl as a plain <a href>. A raw
  // /api/... path navigates the browser to the bare domain, where nginx
  // routes /api/* to ai-shifu (Flask) instead of this app → 404.
  const prev = process.env.APP_BASE_PATH;
  process.env.APP_BASE_PATH = '/wiki';
  try {
    stub.mode = 'pending-then-completed';
    stub.statusCalls = 0;
    const { body } = await postPpt(
      { content: 'Base path deck', nSlides: 1 },
      ownerToken
    );
    const jobId = body.data.jobId as string;
    // First poll: still generating; second poll: Presenton reports completed.
    const first = await getPpt(jobId, ownerToken);
    assert.equal(first.body.data.status, 'generating');
    const got = await getPpt(jobId, ownerToken);
    assert.equal(got.body.data.status, 'completed');
    assert.equal(
      got.body.data.downloadUrl,
      `/wiki/api/admin/agent/presentations/download?id=${jobId}`
    );
  } finally {
    if (prev === undefined) delete process.env.APP_BASE_PATH;
    else process.env.APP_BASE_PATH = prev;
  }
});

test('empty content and nSlides=51 → 400', async () => {
  const empty = await postPpt({}, ownerToken);
  assert.equal(empty.response.status, 400);
  assert.match(empty.body.message, /content, files, or postSlugs/);

  const over = await postPpt({ content: 'x', nSlides: 51 }, ownerToken);
  assert.equal(over.response.status, 400);
  assert.match(over.body.message, /between 1 and 50/);
});

test('quota failure at start → 429 llm_quota_exceeded', async () => {
  stub.createFail = 'quota-429';
  stub.createCalls = 0;
  const { response, body } = await postPpt(
    { content: 'Quota create test', nSlides: 1, mode: 'smart' },
    ownerToken
  );
  assert.equal(response.status, 429);
  assert.match(body.message, /llm_quota_exceeded/);
  assert.equal(stub.createCalls, 1);
  stub.createFail = 'none';
});

test('quota failure during polling surfaces llm_quota_exceeded on the job', async () => {
  stub.mode = 'error-quota';
  stub.statusCalls = 0;
  const { body } = await postPpt(
    { content: 'Quota poll test', nSlides: 1 },
    ownerToken
  );
  const jobId = body.data.jobId as string;
  const got = await getPpt(jobId, ownerToken);
  assert.equal(got.response.status, 200);
  assert.equal(got.body.data.status, 'failed');
  assert.equal(got.body.data.errorCode, 'llm_quota_exceeded');
  assert.match(got.body.data.error, /llm_quota_exceeded/);
});

test('second create within 10s is rate-limited', async () => {
  stub.mode = 'pending';
  const first = await postPpt({ content: 'Rate limit test' }, ownerToken);
  assert.equal(first.response.status, 200);
  // No store clear between the two calls, and a different client IP so
  // only the per-user 10s limit can fire (not the 200ms IP limit).
  const second = await handlers().POST({
    request: new Request('http://localhost/api/ai-assistant/presentations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
        'x-forwarded-for': '10.0.0.2',
      },
      body: JSON.stringify({ content: 'Rate limit test 2' }),
    }),
  });
  assert.equal(second.status, 429);
});
