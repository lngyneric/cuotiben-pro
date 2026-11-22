import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// 学分制带教 Dashboard：服务层单测（纯函数＋隔离 SQLite 库上的范围过滤）。
// 权限口径：管理员全部；导师只看自己名下学员（role_person_map 为准，
// 工号优先、工号为空时按姓名）；学员只看自己；其他人无范围。
// No application modules are loaded until the isolated environment is installed.
const directory = await mkdtemp(
  join(tmpdir(), 'shipany-mentoring-dashboard-test-')
);
Object.assign(process.env, {
  DATABASE_PROVIDER: 'sqlite',
  DATABASE_URL: `file:${join(directory, 'test.db')}`,
  AUTH_SECRET: 'test-auth-secret-mentoring-dashboard',
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
const service = await import('../src/modules/mentoring-dashboard/service');

const NOW = new Date('2026-11-20T11:15:09+08:00');

function statusRow(over: Record<string, unknown>) {
  return {
    id: 'record:seed',
    name: '学员甲',
    employeeNo: null,
    wecomUserId: null,
    wikiUserId: null,
    aishifuUserBid: null,
    department: '销售本部',
    positionName: '区域销售经理',
    mentorLeadId: null,
    mentorLeadName: '导师甲',
    mentors: null,
    planType: '销售',
    planStartDate: '2025-05-12',
    planEndDate: '2025-11-12',
    expectedDate: '2025-09-05',
    plan: JSON.stringify({
      nodes: [
        { node: '0-入职培训', expected: null },
        { node: '1-三个明白-销售', expected: null },
        { node: '2-a-新人训练营', expected: null },
      ],
    }),
    actual: JSON.stringify({
      status: '带教中',
      result: null,
      nodeRatings: null,
      confirmations: [],
      scores: { process: null, gpa: null, elearn: null },
      courses: [],
      progressRecords: 0,
      quizAttempts: 0,
      lastActivityAt: null,
    }),
    flags: JSON.stringify([]),
    planVersion: 'v1',
    sourceWatermarks: null,
    computedAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

before(async () => {
  await db()
    .insert(schema.userStatusSummary)
    .values([
      statusRow({
        id: 'record:a',
        name: '学员甲',
        employeeNo: 'sch00001',
        actual: JSON.stringify({
          status: '完成',
          result: '通过',
          nodeRatings: '优',
          confirmations: [
            {
              node: '0-入职培训',
              timeNode: '节点0',
              passed: '通过',
              confirmedAt: '2025-06-01',
              comments: { lead: '好', keyAccount: null, exempt: null },
            },
            {
              node: '1-三个明白-销售',
              timeNode: '节点1',
              passed: '通过',
              confirmedAt: '2025-08-01',
              comments: { lead: null, keyAccount: null, exempt: null },
            },
          ],
          scores: { process: 88, gpa: 3.5, elearn: 96 },
          courses: [],
          progressRecords: 0,
          quizAttempts: 0,
          lastActivityAt: null,
        }),
        flags: JSON.stringify(['pending_confirm']),
      }),
      statusRow({
        id: 'record:b',
        name: '学员乙',
        employeeNo: 'sch00002',
        expectedDate: '2025-09-24',
        actual: JSON.stringify({
          status: '中断',
          result: null,
          nodeRatings: null,
          confirmations: [],
          scores: { process: null, gpa: null, elearn: 88 },
          courses: [],
          progressRecords: 0,
          quizAttempts: 0,
          lastActivityAt: null,
        }),
        flags: JSON.stringify([
          'overdue',
          'no_course_activity',
          'no_wiki_account',
        ]),
      }),
      statusRow({
        id: 'record:c',
        name: '陈三',
        employeeNo: null,
        planType: '大客户',
        actual: JSON.stringify({
          status: '带教中',
          result: null,
          nodeRatings: null,
          confirmations: [
            {
              node: '0-入职培训',
              timeNode: '节点0',
              passed: '已确认',
              confirmedAt: null,
              comments: { lead: null, keyAccount: null, exempt: null },
            },
          ],
          scores: { process: null, gpa: null, elearn: null },
          courses: [],
          progressRecords: 0,
          quizAttempts: 0,
          lastActivityAt: null,
        }),
        flags: JSON.stringify(['no_wiki_account']),
      }),
    ]);
  await db()
    .insert(schema.rolePersonMap)
    .values([
      {
        id: 'wo_mentor_a',
        name: '导师甲',
        employeeNo: 'sch00010',
        wecomUserId: 'wo_mentor_a',
        role: '导师',
        mentorTypes: JSON.stringify(['带教负责人']),
        mentees: JSON.stringify([
          { name: '学员甲', wecomUserId: 'wo_a', employeeNo: 'sch00001' },
          { name: '陈三', wecomUserId: 'wo_c', employeeNo: null },
        ]),
        mentors: JSON.stringify([]),
        updatedAt: NOW,
      },
      {
        id: 'wo_mentor_b',
        name: '导师乙',
        employeeNo: 'sch00020',
        wecomUserId: 'wo_mentor_b',
        role: '导师',
        mentorTypes: JSON.stringify(['带教负责人']),
        mentees: JSON.stringify([
          { name: '学员乙', wecomUserId: 'wo_b', employeeNo: 'sch00002' },
        ]),
        mentors: JSON.stringify([]),
        updatedAt: NOW,
      },
    ]);
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

test('节点解析：3 节点，expected 恒为 null；空 plan 得空数组', () => {
  const nodes = service.parsePlanNodes(
    JSON.stringify({ nodes: [{ node: '0-入职培训', expected: null }] })
  );
  assert.deepEqual(nodes, [{ node: '0-入职培训', expected: null }]);
  assert.deepEqual(service.parsePlanNodes(null), []);
  assert.deepEqual(service.parsePlanNodes('not-json'), []);
});

test('节点完成态：通过/不通过/已确认/空', () => {
  assert.equal(service.nodeStateFor('通过'), 'passed');
  assert.equal(service.nodeStateFor('不通过'), 'confirmed');
  assert.equal(service.nodeStateFor('未通过'), 'confirmed');
  assert.equal(service.nodeStateFor('已确认'), 'confirmed');
  assert.equal(service.nodeStateFor(''), 'pending');
  assert.equal(service.nodeStateFor(null), 'pending');
});

test('节点完成度：通过 2、已确认 1、待确认 1', () => {
  const nodes = service.parsePlanNodes(
    JSON.stringify({
      nodes: [
        { node: '0-入职培训', expected: null },
        { node: '1-三个明白-销售', expected: null },
        { node: '2-a-新人训练营', expected: null },
      ],
    })
  );
  const confs = service.parseConfirmations(
    JSON.stringify({
      confirmations: [
        { node: '0-入职培训', passed: '通过', confirmedAt: '2025-06-01' },
        { node: '1-三个明白-销售', passed: '已确认', confirmedAt: null },
      ],
    })
  );
  const done = service.buildNodeCompletions(nodes, confs);
  assert.equal(done[0].state, 'passed');
  assert.equal(done[1].state, 'confirmed');
  assert.equal(done[2].state, 'pending');
  assert.equal(done[2].expected, null);
});

test('汇总：总数/状态/计划类型/各旗标计数', () => {
  const rows = [
    { status: '完成', planType: '销售', flags: ['pending_confirm'] },
    {
      status: '中断',
      planType: '销售',
      flags: ['overdue', 'no_course_activity'],
    },
    { status: '带教中', planType: '大客户', flags: ['no_wiki_account'] },
  ].map((r) => ({ ...r }) as never);
  const s = service.summarizeRows(rows as never);
  assert.equal(s.total, 3);
  assert.equal(s.byStatus['完成'], 1);
  assert.equal(s.byPlanType['销售'], 2);
  assert.equal(s.overdue, 1);
  assert.equal(s.pendingConfirm, 1);
  assert.equal(s.noCourseActivity, 1);
  assert.equal(s.noWikiAccount, 1);
});

test('HR 跟进项：只从 flags 派生，顺序固定', () => {
  const items = service.hrFollowUpItems({
    flags: ['no_wiki_account', 'overdue', 'no_course_activity'],
  } as never);
  assert.deepEqual(items, ['overdue', 'no_course_activity', 'no_wiki_account']);
  assert.deepEqual(service.hrFollowUpItems({ flags: [] } as never), []);
});

test('学员—导师匹配：工号优先（不区分大小写），工号为空时按姓名', () => {
  const row = { employeeNo: 'SCH00001', name: '学员甲' } as never;
  assert.equal(
    service.menteeMatchesRow({ name: '学员甲', employeeNo: 'sch00001' }, row),
    true
  );
  assert.equal(
    service.menteeMatchesRow({ name: '陈三', employeeNo: null }, {
      employeeNo: null,
      name: '陈三',
    } as never),
    true
  );
  // mentee 条目无工号时按姓名兜底（与图谱人员轴一致）：行有工号也不否决，
  // 因为两张智能表的工号缺口不一致；但 mentee 条目有工号时工号说了算，
  // 姓名不能推翻工号不匹配。
  assert.equal(
    service.menteeMatchesRow({ name: '陈三', employeeNo: null }, {
      employeeNo: 'sch00003',
      name: '陈三',
    } as never),
    true
  );
  assert.equal(
    service.menteeMatchesRow({ name: '学员甲', employeeNo: 'sch00002' }, row),
    false
  );
});

test('范围解析：管理员 / 导师 / 学员本人 / 其他人', async () => {
  assert.deepEqual(
    await service.resolveDashboardScope({
      isAdmin: true,
      employeeNo: 'sch00099',
    }),
    { kind: 'admin' }
  );
  const mentor = await service.resolveDashboardScope({
    isAdmin: false,
    employeeNo: 'sch00010',
  });
  assert.equal(mentor?.kind, 'mentor');
  if (mentor?.kind === 'mentor') {
    assert.equal(mentor.mentorId, 'wo_mentor_a');
    assert.equal(mentor.mentees.length, 2);
  }
  assert.deepEqual(
    await service.resolveDashboardScope({
      isAdmin: false,
      employeeNo: 'sch00001',
    }),
    { kind: 'self', employeeNo: 'sch00001' }
  );
  assert.equal(
    await service.resolveDashboardScope({
      isAdmin: false,
      employeeNo: 'sch00999',
    }),
    null
  );
  assert.equal(
    await service.resolveDashboardScope({ isAdmin: false, employeeNo: '' }),
    null
  );
});

test('总表：管理员看全部；导师只看自己名下学员（含无工号按姓名匹配的行）', async () => {
  const all = await service.listDashboardRows({ kind: 'admin' }, 'admin');
  assert.ok(!('error' in all));
  if ('error' in all) return;
  assert.equal(all.rows.length, 3);
  assert.equal(all.summary.total, 3);
  assert.equal(all.summary.overdue, 1);
  assert.equal(all.summary.pendingConfirm, 1);
  assert.equal(all.mentors.length, 2);
  assert.equal(all.computedAt, NOW.toISOString());

  const mentorA = await service.resolveDashboardScope({
    isAdmin: false,
    employeeNo: 'sch00010',
  });
  assert.ok(mentorA && mentorA.kind === 'mentor');
  if (!mentorA || mentorA.kind !== 'mentor') return;
  const mine = await service.listDashboardRows(mentorA, 'mentor');
  assert.ok(!('error' in mine));
  if ('error' in mine) return;
  // 学员甲（工号匹配）＋陈三（姓名兜底）；学员乙不在名下。
  assert.deepEqual(mine.rows.map((r) => r.id).sort(), ['record:a', 'record:c']);
  assert.equal(mine.summary.total, 2);
  assert.equal(mine.mentors.length, 1);

  // 学员本人调总表：403。
  assert.deepEqual(
    await service.listDashboardRows(
      { kind: 'self', employeeNo: 'sch00001' },
      'admin'
    ),
    { error: 'forbidden' }
  );
});

test('总表导师预览：未选导师返回空行＋导师列表（供选择器渲染）；不存在的导师报 not_found', async () => {
  // 未选导师不再报 mentor_required：前端查询须拿到 mentors 才能渲染
  // 选择器，否则 isAdminScope 为 false、切换器与选择器一起消失、
  // 页面只剩提示（2026-11-22 实测）。
  const noId = await service.listDashboardRows({ kind: 'admin' }, 'mentor');
  assert.ok(!('error' in noId));
  if ('error' in noId) return;
  assert.equal(noId.view, 'mentor');
  assert.equal(noId.scope, 'admin');
  assert.deepEqual(noId.rows, []);
  assert.equal(noId.summary.total, 0);
  assert.equal(noId.mentors.length, 2);
  assert.equal(noId.computedAt, NOW.toISOString());
  const badId = await service.listDashboardRows(
    { kind: 'admin' },
    'mentor',
    'wo_nope'
  );
  assert.deepEqual(badId, { error: 'mentor_not_found' });
  const preview = await service.listDashboardRows(
    { kind: 'admin' },
    'mentor',
    'wo_mentor_b'
  );
  assert.ok(!('error' in preview));
  if ('error' in preview) return;
  assert.deepEqual(
    preview.rows.map((r) => r.id),
    ['record:b']
  );
  assert.equal(preview.view, 'mentor');
});

test('个人页：管理员任意行；导师只看名下；学员只看自己；不存在报 not_found', async () => {
  const admin = { kind: 'admin' } as const;
  const a = await service.getDashboardPerson(admin, 'record:a');
  assert.ok('person' in a);
  if ('person' in a) {
    assert.equal(a.person.name, '学员甲');
    assert.equal(a.person.completedNodes, 2);
    assert.equal(a.person.totalNodes, 3);
    assert.equal(a.person.nodes[0].state, 'passed');
    assert.equal(a.person.nodes[2].state, 'pending');
    assert.equal(a.person.scores?.elearn, 96);
  }
  // 不带 record: 前缀也能查。
  const bare = await service.getDashboardPerson(admin, 'b');
  assert.ok('person' in bare);

  const mentorA = await service.resolveDashboardScope({
    isAdmin: false,
    employeeNo: 'sch00010',
  });
  assert.ok(mentorA && mentorA.kind === 'mentor');
  if (!mentorA || mentorA.kind !== 'mentor') return;
  assert.ok(
    'person' in (await service.getDashboardPerson(mentorA, 'record:a'))
  );
  assert.ok(
    'person' in (await service.getDashboardPerson(mentorA, 'record:c'))
  );
  assert.deepEqual(await service.getDashboardPerson(mentorA, 'record:b'), {
    error: 'forbidden',
  });

  const self = { kind: 'self', employeeNo: 'sch00001' } as const;
  assert.ok('person' in (await service.getDashboardPerson(self, 'record:a')));
  assert.deepEqual(await service.getDashboardPerson(self, 'record:b'), {
    error: 'forbidden',
  });

  assert.deepEqual(await service.getDashboardPerson(admin, 'record:nope'), {
    error: 'not_found',
  });
});

test('路由结构：个人页能挂载（父路由只渲染 Outlet，总表在 index）', async () => {
  // 2026-11-22 实测：父路由 mentoring-dashboard.tsx 直接渲染总表、
  // 不渲染 Outlet，子路由 $recordId 挂不上——地址与标题变了，正文
  // 仍是总表。与 ai-assistant 的 route.tsx（只挂 Outlet）同一模式。
  // 此单测守住文件结构，防止改回旧结构。
  const { existsSync, readFileSync } = await import('node:fs');
  const base = join(process.cwd(), 'src/routes/mentoring-dashboard');
  const layout = join(base, 'route.tsx');
  const index = join(base, 'index.tsx');
  const person = join(base, '$recordId.tsx');
  const oldParent = join(process.cwd(), 'src/routes/mentoring-dashboard.tsx');

  assert.equal(existsSync(oldParent), false, '旧父路由文件须已删除');
  assert.equal(existsSync(layout), true);
  assert.equal(existsSync(index), true);
  assert.equal(existsSync(person), true);

  const layoutSrc = readFileSync(layout, 'utf8');
  assert.match(layoutSrc, /createFileRoute\('\/mentoring-dashboard'\)/);
  assert.match(layoutSrc, /<Outlet\s*\/>/);
  assert.doesNotMatch(layoutSrc, /MentoringDashboardPage|DataTable/);

  const indexSrc = readFileSync(index, 'utf8');
  assert.match(indexSrc, /createFileRoute\('\/mentoring-dashboard\/'\)/);
  assert.match(indexSrc, /MentoringDashboardPage/);

  const personSrc = readFileSync(person, 'utf8');
  assert.match(
    personSrc,
    /createFileRoute\('\/mentoring-dashboard\/\$recordId'\)/
  );
  assert.match(personSrc, /MentoringPersonPage/);
});

test('导师视角：总表查询不因未选导师而禁用（否则选择器与切换器消失）', async () => {
  // 2026-11-22 实测：查询 enabled 含 !needMentor，导师视角未选导师
  // 时查询禁用、data 为空、isAdminScope 为 false，切换器与选择器
  // 一起消失、页面只剩提示，且无法切回。查询须始终启用。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    join(process.cwd(), 'src/routes/mentoring-dashboard/index.tsx'),
    'utf8'
  );
  assert.doesNotMatch(src, /enabled:\s*!!session\?\.user\s*&&\s*!needMentor/);
  assert.match(src, /enabled:\s*!!session\?\.user,/);
});
