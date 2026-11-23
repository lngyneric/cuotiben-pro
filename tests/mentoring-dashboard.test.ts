import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// 学分制带教 Dashboard：服务层单测（纯函数＋隔离 SQLite 库上的范围过滤）。
// 权限口径：管理员全部；导师只看自己负责的带教记录（按记录的带教负责人
// 姓名，role_person_map 只定“谁是导师”）；学员只看自己；其他人无范围。
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
    // 种子行须在统计口径内（带教开始时间 ≥ 2026-04-01），否则总表
    // 统计不到；口径外的行由“统计口径”单测单独插。
    planStartDate: '2026-05-12',
    planEndDate: '2026-11-12',
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
          // E-learning 类型与分值是同一考核的两面（智能表 `E-learning` 列）。
          elearnType: '转岗',
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
        // 学员乙的行负责人是导师乙（不是默认的导师甲），否则导师甲的
        // 视角会按负责人姓名把这行也算进来。
        mentorLeadName: '导师乙',
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
          // 学员丁同时在两名导师的学员名单里（真实情况：谢艳芳同时在
          // 宫本婕与史飞龙的名单里）。双计划单测用它覆盖旧规则会出错
          // 的场景；服务层按记录的带教负责人过滤，不再读这份名单。
          { name: '学员丁', wecomUserId: 'wo_d', employeeNo: 'sch00004' },
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
          { name: '学员丁', wecomUserId: 'wo_d', employeeNo: 'sch00004' },
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

test('记录—导师匹配：按带教负责人姓名（唯一可用键）', () => {
  // 行上的 mentor_lead_id 是企微数字内码（2026-11-23 实查：162/163 行
  // 为 1688… 数字串，与 role_person_map 的 wecom_user_id / id 零匹配），
  // 行上没有导师工号；姓名是唯一共有键。角色人员表无重名（2026-11-19
  // 核查 210 行），同名时两人记录会同时落到同名导师名下，须人工处理。
  const row = { mentorLeadName: '导师甲' } as never;
  assert.equal(service.rowMentorMatches('导师甲', row), true);
  assert.equal(service.rowMentorMatches('导师乙', row), false);
  assert.equal(service.rowMentorMatches(null, row), false);
  assert.equal(service.rowMentorMatches('', row), false);
  assert.equal(
    service.rowMentorMatches('导师甲', { mentorLeadName: null } as never),
    false
  );
  assert.equal(
    service.rowMentorMatches('导师甲', { mentorLeadName: '' } as never),
    false
  );
  // 首尾空白不影响匹配。
  assert.equal(
    service.rowMentorMatches(' 导师甲 ', {
      mentorLeadName: '导师甲',
    } as never),
    true
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
    assert.equal(mentor.mentorName, '导师甲');
    assert.equal(mentor.employeeNo, 'sch00010');
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

test('总表：管理员看全部；导师只看自己负责的记录（按带教负责人姓名）', async () => {
  const all = await service.listDashboardRows({ kind: 'admin' }, 'admin');
  assert.ok(!('error' in all));
  if ('error' in all) return;
  assert.equal(all.rows.length, 3);
  assert.equal(all.summary.total, 3);
  assert.equal(all.summary.overdue, 1);
  assert.equal(all.summary.pendingConfirm, 1);
  assert.equal(all.mentors.length, 2);
  assert.equal(all.computedAt, NOW.toISOString());
  // E-learning 类型：有值原样透出（转岗），无值为空（同步未写该字段的老行）。
  assert.equal(all.rows.find((r) => r.id === 'record:a')?.elearnType, '转岗');
  assert.equal(all.rows.find((r) => r.id === 'record:c')?.elearnType, null);
  // 统计口径信息：3 行都在范围内，无排除。
  assert.deepEqual(all.scopeInfo, {
    cutoff: '2026-04-01',
    included: 3,
    excluded: 0,
    excludedBeforeCutoff: 0,
    excludedNoStartDate: 0,
  });

  const mentorA = await service.resolveDashboardScope({
    isAdmin: false,
    employeeNo: 'sch00010',
  });
  assert.ok(mentorA && mentorA.kind === 'mentor');
  if (!mentorA || mentorA.kind !== 'mentor') return;
  const mine = await service.listDashboardRows(mentorA, 'mentor');
  assert.ok(!('error' in mine));
  if ('error' in mine) return;
  // 学员甲与陈三的行负责人都是导师甲；学员乙的行负责人是导师乙。
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

test('导师视角按记录过滤：同一学员的两条计划分属两位导师时各只看自己那条', async () => {
  // 2026-11-22 实测：谢艳芳（sch01626）两条计划的负责人分别是宫本婕与
  // 史飞龙，两位导师的学员名单里都有她；旧规则按学员过滤，两人都会看到
  // 两条记录。新规则按记录的带教负责人过滤，各只看自己那条。
  // 学员丁已在两名导师的学员名单里（before 种子），与真实情况一致。
  const extra = [
    statusRow({
      id: 'record:e1',
      name: '学员丁',
      employeeNo: 'sch00004',
      mentorLeadName: '导师甲',
      planStartDate: '2026-05-12',
    }),
    statusRow({
      id: 'record:e2',
      name: '学员丁',
      employeeNo: 'sch00004',
      mentorLeadName: '导师乙',
      planStartDate: '2026-06-01',
    }),
  ];
  await db().insert(schema.userStatusSummary).values(extra);
  try {
    // 管理员预览：导师甲只看到 e1，导师乙只看到 e2。
    const previewA = await service.listDashboardRows(
      { kind: 'admin' },
      'mentor',
      'wo_mentor_a'
    );
    assert.ok(!('error' in previewA));
    if ('error' in previewA) return;
    assert.deepEqual(previewA.rows.map((r) => r.id).sort(), [
      'record:a',
      'record:c',
      'record:e1',
    ]);
    const previewB = await service.listDashboardRows(
      { kind: 'admin' },
      'mentor',
      'wo_mentor_b'
    );
    assert.ok(!('error' in previewB));
    if ('error' in previewB) return;
    assert.deepEqual(previewB.rows.map((r) => r.id).sort(), [
      'record:b',
      'record:e2',
    ]);

    // 选择器计数与过滤后的行数一致（记录数，不是学员人数）。
    assert.equal(
      previewA.mentors.find((m) => m.id === 'wo_mentor_a')?.menteeCount,
      3
    );
    assert.equal(
      previewA.mentors.find((m) => m.id === 'wo_mentor_b')?.menteeCount,
      2
    );

    // 导师本人登录：同样只看自己那条。
    const mentorA = await service.resolveDashboardScope({
      isAdmin: false,
      employeeNo: 'sch00010',
    });
    assert.ok(mentorA && mentorA.kind === 'mentor');
    if (!mentorA || mentorA.kind !== 'mentor') return;
    const mineA = await service.listDashboardRows(mentorA, 'mentor');
    assert.ok(!('error' in mineA));
    if ('error' in mineA) return;
    assert.deepEqual(mineA.rows.map((r) => r.id).sort(), [
      'record:a',
      'record:c',
      'record:e1',
    ]);

    const mentorB = await service.resolveDashboardScope({
      isAdmin: false,
      employeeNo: 'sch00020',
    });
    assert.ok(mentorB && mentorB.kind === 'mentor');
    if (!mentorB || mentorB.kind !== 'mentor') return;
    const mineB = await service.listDashboardRows(mentorB, 'mentor');
    assert.ok(!('error' in mineB));
    if ('error' in mineB) return;
    assert.deepEqual(mineB.rows.map((r) => r.id).sort(), [
      'record:b',
      'record:e2',
    ]);

    // 个人页：导师甲能看 e1、看不到 e2；导师乙反之。
    assert.ok(
      'person' in (await service.getDashboardPerson(mentorA, 'record:e1'))
    );
    assert.deepEqual(await service.getDashboardPerson(mentorA, 'record:e2'), {
      error: 'forbidden',
    });
    assert.ok(
      'person' in (await service.getDashboardPerson(mentorB, 'record:e2'))
    );
    assert.deepEqual(await service.getDashboardPerson(mentorB, 'record:e1'), {
      error: 'forbidden',
    });
  } finally {
    const { inArray } = await import('drizzle-orm');
    await db()
      .delete(schema.userStatusSummary)
      .where(inArray(schema.userStatusSummary.id, ['record:e1', 'record:e2']));
  }
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
    assert.equal(a.person.elearnType, '转岗');
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

test('个人页：逾期字段与总表同源（flags 里的 overdue），始终可见', async () => {
  // 总表逾期列与个人页逾期字段都取同步算好的 flags，不重算逾期规则。
  // record:b 的 flags 含 overdue，record:a 不含。
  const admin = { kind: 'admin' } as const;
  const b = await service.getDashboardPerson(admin, 'record:b');
  assert.ok('person' in b);
  if ('person' in b) assert.ok(b.person.flags.includes('overdue'));
  const a = await service.getDashboardPerson(admin, 'record:a');
  assert.ok('person' in a);
  if ('person' in a) assert.equal(a.person.flags.includes('overdue'), false);

  // 个人页抬头须有逾期字段：逾期时徽章、未逾期时 —（与总表列一致），
  // 而不是只在逾期时才出现一个徽章。
  const { readFileSync } = await import('node:fs');
  const personSrc = readFileSync(
    join(process.cwd(), 'src/routes/mentoring-dashboard/$recordId.tsx'),
    'utf8'
  );
  assert.match(personSrc, /mentoring_dashboard\.col_overdue/);
  assert.match(personSrc, /mentoring_dashboard\.flag_overdue/);
  assert.match(personSrc, /flags\.includes\('overdue'\)/);
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

test('统计口径：带教开始时间 < 2026-04-01 或无开始时间的行不进 Dashboard', async () => {
  // 用户 2026-11-22 定：只统计带教开始时间 ≥ 2026-04-01 的学员，
  // 其他学员不做统计。口径在服务层过滤：总表、汇总、导师名下计数、
  // 个人页一律只看范围内行；无开始时间的行无法证明在范围内，也排除。
  assert.equal(service.isInScopeStartDate('2026-04-01'), true);
  assert.equal(service.isInScopeStartDate('2026-04-02'), true);
  assert.equal(service.isInScopeStartDate('2026-11-22'), true);
  assert.equal(service.isInScopeStartDate('2026-03-31'), false);
  assert.equal(service.isInScopeStartDate('2024-10-28'), false);
  assert.equal(service.isInScopeStartDate(null), false);
  assert.equal(service.isInScopeStartDate(''), false);
  assert.deepEqual(
    service.buildScopeInfo([
      { planStartDate: '2026-04-01' },
      { planStartDate: '2026-03-31' },
      { planStartDate: null },
      { planStartDate: '' },
    ] as never),
    {
      cutoff: '2026-04-01',
      included: 1,
      excluded: 3,
      excludedBeforeCutoff: 1,
      excludedNoStartDate: 2,
    }
  );

  // 插三行口径外/边界行：边界日纳入、前一天排除、无开始时间排除。
  const extra = [
    statusRow({
      id: 'record:d1',
      name: '学员丁',
      employeeNo: 'sch00004',
      planStartDate: '2026-04-01',
      planEndDate: '2026-10-01',
    }),
    statusRow({
      id: 'record:d2',
      name: '学员戊',
      employeeNo: 'sch00005',
      planStartDate: '2026-03-31',
      planEndDate: '2026-09-30',
    }),
    statusRow({
      id: 'record:d3',
      name: '学员己',
      employeeNo: 'sch00006',
      planStartDate: null,
      planEndDate: null,
    }),
  ];
  await db().insert(schema.userStatusSummary).values(extra);
  try {
    const admin = { kind: 'admin' } as const;
    const all = await service.listDashboardRows(admin, 'admin');
    assert.ok(!('error' in all));
    if ('error' in all) return;
    // 原 3 行在范围内 ＋ 边界日 1 行；前一天与无开始时间不进。
    assert.deepEqual(all.rows.map((r) => r.id).sort(), [
      'record:a',
      'record:b',
      'record:c',
      'record:d1',
    ]);
    assert.equal(all.summary.total, 4);
    assert.deepEqual(all.scopeInfo, {
      cutoff: '2026-04-01',
      included: 4,
      excluded: 2,
      excludedBeforeCutoff: 1,
      excludedNoStartDate: 1,
    });

    // 个人页：边界日能看；口径外的行按 not_found（不在 Dashboard 范围内）。
    assert.ok('person' in (await service.getDashboardPerson(admin, 'd1')));
    assert.deepEqual(await service.getDashboardPerson(admin, 'd2'), {
      error: 'not_found',
    });
    assert.deepEqual(await service.getDashboardPerson(admin, 'd3'), {
      error: 'not_found',
    });
  } finally {
    const { inArray } = await import('drizzle-orm');
    await db()
      .delete(schema.userStatusSummary)
      .where(
        inArray(schema.userStatusSummary.id, [
          'record:d1',
          'record:d2',
          'record:d3',
        ])
      );
  }
});

test('统计口径与 E-learning 类型在页面上可见（总表口径行＋类型列＋个人页类型）', async () => {
  // 2026-11-22 定：总表页须写明统计范围，页底数据说明须记录 cutoff
  // 与排除行数；E-learning 类型须在总表列与个人页都出现。
  const { readFileSync } = await import('node:fs');
  const indexSrc = readFileSync(
    join(process.cwd(), 'src/routes/mentoring-dashboard/index.tsx'),
    'utf8'
  );
  assert.match(indexSrc, /mentoring_dashboard\.scope_line/);
  assert.match(indexSrc, /mentoring_dashboard\.scope_note/);
  assert.match(indexSrc, /mentoring_dashboard\.col_elearn_type/);
  assert.match(indexSrc, /scopeInfo/);
  const personSrc = readFileSync(
    join(process.cwd(), 'src/routes/mentoring-dashboard/$recordId.tsx'),
    'utf8'
  );
  assert.match(personSrc, /mentoring_dashboard\.col_elearn_type/);
  assert.match(personSrc, /elearnType/);
});
