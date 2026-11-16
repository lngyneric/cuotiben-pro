import assert from 'node:assert/strict';
import { test } from 'node:test';

// AI 学习助手 Jev 路由是纯函数：不读数据库、不读配置，
// 传输层可注入桩，所以这些测试全程不联网、不读 key。
const {
  callJevRouting,
  isOffTopicIntent,
  jevShortlist,
  keywordRecommend,
  keywordScoreList,
} = await import('@/modules/ai-assistant/service');

const catalog = [
  {
    slug: 'course-leadership',
    title: '从事到人：打造一流的团队执行力',
    description: '领导力培训视频，讲目标、标准与反馈。',
    categories: ['领导力'],
  },
  {
    slug: 'course-sales',
    title: '销售技巧：如何形成有力论据',
    description: '销售沟通与论据组织。',
    categories: ['销售'],
  },
  {
    slug: 'course-lab',
    title: '尿液检验基础',
    description: '检验科入门，尿液样本处理流程。',
    categories: ['检验'],
  },
];

test('keywordScoreList：标题 3 分 > 分类 2 分 > 简介 1 分，按分数降序', () => {
  const scored = keywordScoreList(catalog, '领导力');
  assert.deepEqual(
    scored.map((s) => s.slug),
    ['course-leadership']
  );
  assert.equal(scored[0].score, 2 + 1); // 分类命中 + 简介命中（标题“团队执行力”不含“领导力”）
  assert.deepEqual(keywordScoreList(catalog, '不存在的词'), []);
});

test('keywordRecommend：行为不变，只取前 2 门', () => {
  assert.deepEqual(keywordRecommend(catalog, '销售'), ['course-sales']);
  assert.deepEqual(keywordRecommend(catalog, '检验'), ['course-lab']);
  assert.deepEqual(keywordRecommend(catalog, ''), []);
});

// 自然问句预筛用目录：3 门领导力课 + 销售 + 检验。
const naturalCatalog = [
  {
    slug: 'course-leadership',
    title: '从事到人：打造一流的团队执行力',
    description: '领导力培训视频，讲目标、标准与反馈。',
    categories: ['领导力'],
  },
  {
    slug: 'course-new-manager',
    title: 'AI新经理操作指南',
    description: '领导力培训视频',
    categories: ['领导力'],
  },
  {
    slug: 'course-team',
    title: 'Will-Skill矩阵“盘”团队',
    description: '领导力培训视频',
    categories: ['领导力'],
  },
  {
    slug: 'course-sales',
    title: '销售技巧：如何形成有力论据',
    description: '销售沟通与论据组织。',
    categories: ['销售'],
  },
  {
    slug: 'course-lab',
    title: '尿液检验基础',
    description: '检验科入门，尿液样本处理流程。',
    categories: ['检验'],
  },
];

test('keywordScoreList：自然问句能筛出领导力候选（反向分类 + 2 字 gram）', () => {
  const scored = keywordScoreList(
    naturalCatalog,
    '我想学领导力，有什么课程推荐？'
  );
  // 3 门领导力课都命中（分类反向包含 + 简介 gram），销售 / 检验 0 分
  assert.deepEqual(
    scored.map((s) => s.slug),
    ['course-leadership', 'course-new-manager', 'course-team']
  );
  assert.equal(scored[0].score, 6); // 分类 2×2（分词 + 整句）+ 简介 1×2
});

test('keywordScoreList：单关键词“领导力”回归（分值不变）', () => {
  const scored = keywordScoreList(naturalCatalog, '领导力');
  assert.deepEqual(
    scored.map((s) => s.slug),
    ['course-leadership', 'course-new-manager', 'course-team']
  );
  // 每门都是分类 2 + 简介 1；词族在同一字段上只计一次，不因 gram 膨胀
  assert.deepEqual(
    scored.map((s) => s.score),
    [3, 3, 3]
  );
});

test('keywordScoreList：无关问句“怎么请假”筛不出候选', () => {
  assert.deepEqual(keywordScoreList(naturalCatalog, '怎么请假'), []);
  assert.deepEqual(keywordScoreList(catalog, '怎么请假'), []);
});

test('keywordScoreList：标题关键词 gram 能命中自然问句里的“盘团队”', () => {
  const scored = keywordScoreList(naturalCatalog, '怎么盘团队');
  assert.ok(scored.map((s) => s.slug).includes('course-team'));
});

test('callJevRouting：无 key 时不发请求，直接返回 null', async () => {
  let called = 0;
  const res = await callJevRouting(
    { apiKey: '', query: '想学领导力', candidates: catalog.slice(0, 1) },
    {
      postJson: async () => {
        called++;
        return { status: 200, body: '{}' };
      },
    }
  );
  assert.equal(res, null);
  assert.equal(called, 0);
});

test('callJevRouting：一次调用并行问意图 + 每门候选打分，解析并排序', async () => {
  let sentPayload: any;
  const stub = {
    postJson: async (_url: string, payload: unknown) => {
      sentPayload = payload;
      return {
        status: 200,
        body: JSON.stringify({
          answers: {
            intent: { type: 'choice', choice: 'recommend', confidence: 0.8 },
            rel_0: { type: 'noul', noul: 0.91 },
            rel_1: { type: 'noul', noul: 0.2 },
          },
        }),
      };
    },
  };
  const res = await callJevRouting(
    {
      apiKey: 'test-key',
      query: '想学领导力',
      candidates: catalog.slice(0, 2),
    },
    stub
  );
  assert.ok(res);
  assert.equal(res.intent, 'recommend');
  assert.equal(res.intentConfidence, 0.8);
  // 请求形状：意图 choice 题 + 每门候选一题 noul，state 带原问句与候选表
  assert.equal(sentPayload.model, 'jev-latest');
  assert.equal(sentPayload.state.message, '想学领导力');
  assert.equal(sentPayload.questions.intent.type, 'choice');
  assert.deepEqual(Object.keys(sentPayload.questions.intent.criteria), [
    'recommend',
    'course_info',
    'study_plan',
    'other',
  ]);
  assert.equal(sentPayload.questions.rel_0.type, 'noul');
  assert.equal(sentPayload.questions.rel_1.type, 'noul');
  // 打分按 noul 降序
  assert.deepEqual(
    res.scores.map((s) => s.slug),
    ['course-leadership', 'course-sales']
  );
  assert.equal(res.scores[0].noul, 0.91);
});

test('jevShortlist：只取打分 ≥0.6 的，最多 2 门；低分返回空', () => {
  assert.deepEqual(
    jevShortlist({
      intent: 'recommend',
      intentConfidence: 0.8,
      scores: [
        { slug: 'course-leadership', noul: 0.91 },
        { slug: 'course-sales', noul: 0.2 },
      ],
    }),
    ['course-leadership']
  );
  assert.deepEqual(
    jevShortlist({
      intent: 'recommend',
      intentConfidence: 0.8,
      scores: [
        { slug: 'course-leadership', noul: 0.5 },
        { slug: 'course-sales', noul: 0.4 },
      ],
    }),
    []
  );
  assert.deepEqual(jevShortlist(null), []);
});

test('isOffTopicIntent：意图 other 且置信度 ≥0.7 才算无关', () => {
  const other = (conf: number) => ({
    intent: 'other' as const,
    intentConfidence: conf,
    scores: [],
  });
  assert.equal(isOffTopicIntent(other(0.9)), true);
  assert.equal(isOffTopicIntent(other(0.7)), true);
  assert.equal(isOffTopicIntent(other(0.5)), false);
  assert.equal(
    isOffTopicIntent({
      intent: 'recommend',
      intentConfidence: 0.99,
      scores: [],
    }),
    false
  );
  assert.equal(isOffTopicIntent(null), false);
});

test('callJevRouting：候选为空时只问意图一题', async () => {
  let sentPayload: any;
  const res = await callJevRouting(
    { apiKey: 'test-key', query: '怎么请假', candidates: [] },
    {
      postJson: async (_url: string, payload: unknown) => {
        sentPayload = payload;
        return {
          status: 200,
          body: JSON.stringify({
            answers: {
              intent: { type: 'choice', choice: 'other', confidence: 0.92 },
            },
          }),
        };
      },
    }
  );
  assert.ok(res);
  assert.deepEqual(Object.keys(sentPayload.questions), ['intent']);
  assert.deepEqual(res.scores, []);
  assert.equal(isOffTopicIntent(res), true);
});

test('callJevRouting：非 200 / 非法 JSON / 非法意图 / 传输抛错都返回 null', async () => {
  const base = {
    apiKey: 'test-key',
    query: '想学领导力',
    candidates: catalog.slice(0, 1),
  };
  const cases = [
    { postJson: async () => ({ status: 451, body: 'blocked' }) },
    { postJson: async () => ({ status: 200, body: 'not-json{' }) },
    {
      postJson: async () => ({
        status: 200,
        body: JSON.stringify({
          answers: { intent: { choice: 'nonsense', confidence: 0.9 } },
        }),
      }),
    },
    {
      postJson: async () => {
        throw new Error('timeout');
      },
    },
  ];
  for (const transport of cases) {
    assert.equal(await callJevRouting(base, transport), null);
  }
});
