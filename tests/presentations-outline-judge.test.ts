// 轻量路（2026-11-26）：outline 走 Magpie LLM 分组＋Jev 判分组。
// 直接调 buildOutline（注入 fetchImpl / jevTransport 桩），全程不联网。
// Jev 桩按 JevTransport 形状（postJson → {status, body}），答案是
// {noul}；Magpie 桩按 fetch 形状，返回 OpenAI chat completions JSON。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// No application modules are loaded until the isolated environment is installed.
const directory = await mkdtemp(join(tmpdir(), 'shipany-outline-judge-test-'));
Object.assign(process.env, {
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: `file:${directory}/test.db`,
  AUTH_SECRET: 'test-secret-for-outline-judge',
  NODE_ENV: 'test',
  VITE_APP_URL: 'http://localhost:3000',
  // Jev key 走服务器环境变量（与 AI 学习助手推荐链路同款），
  // 不走 config 表：resolveOutlineJevConfig 只读 envConfigs。
  TYPESAFE_API_KEY: 'test-jev-key',
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
const { saveConfigs } = await import('../src/modules/config/service');
const {
  buildOutline,
  confirmOutline,
  getOwnedOutline,
  outlineVerdictView,
  registerUploadTextBytes,
} = await import('../src/modules/presentations/sources');
const presentationsService =
  await import('../src/modules/presentations/service');
const { parseGenerationMeta } =
  await import('../src/modules/presentations/job-meta');
const { parseOutlineVerdict } =
  await import('../src/modules/presentations/outline-llm');

const OWNER = { userId: 'judge-user', tokenId: null };

// 两主题上传文本：splitSections 切出 2 段（段 0 销售、段 1 团队）。
const TWO_TOPIC = `# 销售技巧
销售话术要点一：先听后说，了解客户真实需求。
销售话术要点二：用数据说话，准备三个成功案例。

# 团队管理
团队管理要点一：每周一次一对一，了解成员状态。
团队管理要点二：目标拆解到周，进度可视化。
`;

// --- Magpie 桩 -------------------------------------------------------------
// LLM 分组只按段落编号归属：段 0 → 第 1 页，段 1 → 第 2 页。
function magpieOkJson() {
  return {
    choices: [
      {
        message: {
          // 按提示词格式：{"pages":[{title, sections, layout, reason}]}。
          content: JSON.stringify({
            pages: [
              {
                title: '销售技巧',
                sections: [0],
                layout: 'A',
                reason: '主题页',
              },
              {
                title: '团队管理',
                sections: [1],
                layout: 'B',
                reason: '要点页',
              },
            ],
          }),
        },
      },
    ],
  };
}

type MagpieMode = 'ok' | 'bad-json' | 'http500' | 'throw';
function magpieFetch(mode: MagpieMode) {
  let calls = 0;
  const fn = (async () => {
    calls += 1;
    if (mode === 'throw') throw new Error('magpie down');
    if (mode === 'http500')
      return new Response('boom', { status: 500 });
    if (mode === 'bad-json')
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '不是 JSON' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    return new Response(JSON.stringify(magpieOkJson()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

// --- Jev 桩 ----------------------------------------------------------------
// mode=pass：全部 0.9；fail-page-2-first：第一次调用第 2 页相关性 0.3，
// 之后全过；fail-always：第 1 页相关性恒 0.2；throw：传输层抛错。
type JevMode = 'pass' | 'fail-page-2-first' | 'fail-always' | 'throw';
function jevTransport(mode: JevMode) {
  let calls = 0;
  const transport = {
    postJson: async (_url: string, payload: any) => {
      calls += 1;
      if (mode === 'throw') throw new Error('jev down');
      const questions = (payload?.questions ?? {}) as Record<string, unknown>;
      const answers: Record<string, { noul: number }> = {};
      for (const id of Object.keys(questions)) answers[id] = { noul: 0.9 };
      if (mode === 'fail-page-2-first' && calls === 1)
        answers['rel_1'] = { noul: 0.3 };
      if (mode === 'fail-always') answers['rel_0'] = { noul: 0.2 };
      return { status: 200, body: JSON.stringify({ answers }) };
    },
  };
  return { transport, calls: () => calls };
}

// --- Presenton 桩（只够 createJobAndStart 走到生成中） ----------------------
function presentonFetch(): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
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
          remaining_slides: 2,
        },
      });
    return Promise.resolve(new Response('not found', { status: 404 }));
  }) as unknown as typeof fetch;
}

before(async () => {
  globalThis.fetch = presentonFetch();
  await saveConfigs({
    presenton_base_url: 'http://presenton.test',
    presenton_api_key: 'test-presenton-key',
    openai_base_url: 'http://magpie.test',
    openai_api_key: 'test-magpie-key',
  });
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function registerTwoTopic() {
  const row = await registerUploadTextBytes(OWNER, {
    name: 'two-topic.txt',
    mime: 'text/plain',
    bytes: Buffer.from(TWO_TOPIC),
  });
  return row.id;
}

test('LLM 分组有效 + Jev 全过 → verdict=pass，页与 source refs 正确', async () => {
  const sourceId = await registerTwoTopic();
  const magpie = magpieFetch('ok');
  const jev = jevTransport('pass');
  const row = await buildOutline(OWNER, [sourceId], {
    intent: '给新员工讲销售技巧与团队管理',
    deps: { fetchImpl: magpie.fn, jevTransport: jev.transport },
  });
  const pages = JSON.parse(row.pages) as any[];
  assert.equal(pages.length, 2);
  assert.deepEqual(
    pages.map((p) => p.title),
    ['销售技巧', '团队管理']
  );
  // 要点仍从来源原文取（LLM 只分组，不编内容）。
  assert.ok(pages[0].points.some((pt: string) => pt.includes('先听后说')));
  assert.ok(pages[1].points.some((pt: string) => pt.includes('一对一')));
  // source refs 不丢。
  for (const p of pages) {
    assert.equal(p.sources[0].sourceId, sourceId);
    assert.equal(p.sources[0].sourceKind, 'upload_text');
  }
  const verdict = outlineVerdictView(row);
  assert.equal(verdict?.status, 'pass');
  assert.equal(verdict?.splitMode, 'llm');
  assert.equal(verdict?.attempts, 1);
  assert.equal(verdict?.scores.length, 2);
  assert.ok((verdict?.scores ?? []).every((s) => !s.failed));
  assert.equal(magpie.calls(), 1);
  assert.equal(jev.calls(), 1);
});

test('LLM 返回非法 JSON / 500 / 抛错 → 确定性拆分兜底，流程照常', async () => {
  for (const mode of ['bad-json', 'http500', 'throw'] as const) {
    const sourceId = await registerTwoTopic();
    const magpie = magpieFetch(mode);
    const jev = jevTransport('pass');
    const row = await buildOutline(OWNER, [sourceId], {
      intent: '给新员工讲销售技巧与团队管理',
      deps: { fetchImpl: magpie.fn, jevTransport: jev.transport },
    });
    const pages = JSON.parse(row.pages) as any[];
    assert.equal(pages.length, 2, mode);
    assert.deepEqual(
      pages.map((p) => p.title),
      ['销售技巧', '团队管理'],
      mode
    );
    const verdict = outlineVerdictView(row);
    assert.equal(verdict?.status, 'pass', mode);
    assert.equal(verdict?.splitMode, 'deterministic', mode);
  }
});

test('Jev 一页不通过 → 自动重分一次，复判通过（attempts=2，status=pass）', async () => {
  const sourceId = await registerTwoTopic();
  const magpie = magpieFetch('ok');
  const jev = jevTransport('fail-page-2-first');
  const row = await buildOutline(OWNER, [sourceId], {
    intent: '给新员工讲销售技巧与团队管理',
    deps: { fetchImpl: magpie.fn, jevTransport: jev.transport },
  });
  const verdict = outlineVerdictView(row);
  assert.equal(verdict?.status, 'pass');
  assert.equal(verdict?.attempts, 2);
  assert.ok((verdict?.scores ?? []).every((s) => !s.failed));
  // 重分确实跑了：Magpie 调了两次（正常粒度 + 更细粒度）。
  assert.equal(magpie.calls(), 2);
  assert.equal(jev.calls(), 2);
});

test('Jev 两次都不通过 → needs_review，草稿带疑点页＋原因返回', async () => {
  const sourceId = await registerTwoTopic();
  const magpie = magpieFetch('ok');
  const jev = jevTransport('fail-always');
  const row = await buildOutline(OWNER, [sourceId], {
    intent: '给新员工讲销售技巧与团队管理',
    deps: { fetchImpl: magpie.fn, jevTransport: jev.transport },
  });
  // 草稿仍返回，不静默通过、不死循环。
  const pages = JSON.parse(row.pages) as any[];
  assert.equal(pages.length, 2);
  const verdict = outlineVerdictView(row);
  assert.equal(verdict?.status, 'needs_review');
  assert.equal(verdict?.attempts, 2);
  const failed = (verdict?.scores ?? []).filter((s) => s.failed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].pageNo, 1);
  assert.ok(failed[0].reasons.length > 0);
  assert.ok((verdict?.warnings ?? []).some((w) => w.includes('第 1 页')));
  assert.ok(
    (verdict?.warnings ?? []).some((w) => w.includes('已自动重分一次'))
  );
  assert.equal(magpie.calls(), 2);
  assert.equal(jev.calls(), 2);
});

test('Jev 不可用（传输层抛错）→ skipped，草稿照常返回、不阻塞', async () => {
  const sourceId = await registerTwoTopic();
  const magpie = magpieFetch('ok');
  const jev = jevTransport('throw');
  const row = await buildOutline(OWNER, [sourceId], {
    intent: '给新员工讲销售技巧与团队管理',
    deps: { fetchImpl: magpie.fn, jevTransport: jev.transport },
  });
  const pages = JSON.parse(row.pages) as any[];
  assert.equal(pages.length, 2);
  const verdict = outlineVerdictView(row);
  assert.equal(verdict?.status, 'skipped');
  assert.ok((verdict?.warnings ?? []).some((w) => w.includes('Jev 分组判定不可用')));
  // 只调了一次 LLM（判定跳过后不再重分）。
  assert.equal(magpie.calls(), 1);
});

test('confirm 改了 pages → verdict 清空；不改 pages → verdict 保留', async () => {
  const sourceId = await registerTwoTopic();
  const magpie = magpieFetch('ok');
  const jev = jevTransport('pass');
  const draft = await buildOutline(OWNER, [sourceId], {
    intent: '给新员工讲销售技巧与团队管理',
    deps: { fetchImpl: magpie.fn, jevTransport: jev.transport },
  });
  assert.equal(outlineVerdictView(draft)?.status, 'pass');
  // 不改 pages 确认：verdict 保留。
  const kept = await confirmOutline(OWNER, draft.id);
  assert.equal(outlineVerdictView(kept)?.status, 'pass');

  const draft2 = await buildOutline(OWNER, [sourceId], {
    intent: '给新员工讲销售技巧与团队管理',
    deps: { fetchImpl: magpie.fn, jevTransport: jev.transport },
  });
  const pages = JSON.parse(draft2.pages) as any[];
  pages[0].title = '改过的标题';
  const edited = await confirmOutline(OWNER, draft2.id, pages);
  assert.equal(edited.verdict, null);
  assert.equal(outlineVerdictView(edited), null);
  assert.equal(parseOutlineVerdict(edited.verdict), null);
});

test('生成时 outline 的 verdict 进 generation_meta', async () => {
  const sourceId = await registerTwoTopic();
  const magpie = magpieFetch('ok');
  const jev = jevTransport('pass');
  const draft = await buildOutline(OWNER, [sourceId], {
    intent: '给新员工讲销售技巧与团队管理',
    deps: { fetchImpl: magpie.fn, jevTransport: jev.transport },
  });
  const confirmed = await confirmOutline(OWNER, draft.id);
  const job = await presentationsService.createJobAndStart({
    ownerUserId: OWNER.userId,
    ownerTokenId: OWNER.tokenId,
    input: {
      outlineId: confirmed.id,
      sourceIds: [sourceId],
      nSlides: 2,
      mode: 'standard',
    },
  });
  const meta = parseGenerationMeta(job.generationMeta);
  assert.ok(meta);
  assert.equal(meta?.outlineVerdict?.status, 'pass');
  assert.equal(meta?.outlineVerdict?.splitMode, 'llm');
  assert.equal(meta?.expectedSlides, 2);
});

test('生成时用户改过页面的 outline：generation_meta 不带 verdict', async () => {
  const sourceId = await registerTwoTopic();
  const magpie = magpieFetch('ok');
  const jev = jevTransport('pass');
  const draft = await buildOutline(OWNER, [sourceId], {
    intent: '给新员工讲销售技巧与团队管理',
    deps: { fetchImpl: magpie.fn, jevTransport: jev.transport },
  });
  const pages = JSON.parse(draft.pages) as any[];
  pages[0].title = '改过的标题';
  const confirmed = await confirmOutline(OWNER, draft.id, pages);
  assert.equal(confirmed.verdict, null);
  const job = await presentationsService.createJobAndStart({
    ownerUserId: OWNER.userId,
    ownerTokenId: OWNER.tokenId,
    input: {
      outlineId: confirmed.id,
      sourceIds: [sourceId],
      nSlides: 2,
      mode: 'standard',
    },
  });
  const meta = parseGenerationMeta(job.generationMeta);
  assert.ok(meta);
  assert.equal(meta?.outlineVerdict, undefined);
});
