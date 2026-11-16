import assert from 'node:assert/strict';
import { test } from 'node:test';

// AI 学习助手文档问答：解析、检索、路由决策。
// 纯函数测试（解析 / 打分 / Jev 桩）不联网；runAssistantQuery 的 LLM
// 调用走全局 fetch 桩，不读 key、不读库。
const { buildDocSections, parseHtmlSections } =
  await import('@/modules/ai-assistant/doc-sections');
const {
  callJevRouting,
  docKeywordScoreList,
  isDocIntent,
  isOffTopicIntent,
  jevDocShortlist,
  runAssistantQuery,
} = await import('@/modules/ai-assistant/service');

function makeDocHtml(): string {
  const sections = [
    {
      id: 'p00',
      title: '开始这里：第一周导航',
      body: '<p>这一周你只需要看这一个知识库。</p>',
    },
    {
      id: 'p01',
      title: '入职前准备（报到当天之前）',
      body: '<p>报到前准备好身份证件 &amp; 相关材料。</p>',
    },
    {
      id: 'p02',
      title: '第一天：报到与安顿',
      body: '<p>第一天到 HR 处报到。</p>',
    },
    {
      id: 'p03',
      title: '常用系统与账号',
      body: '<p>OA 系统账号由 IT 开通，邮箱与考勤系统入口见内网。</p>',
    },
    {
      id: 'p04',
      title: '考勤、请假与日常制度速览',
      body:
        '<p>只放第一周会用到的制度速览：考勤怎么记、请假怎么提。细则以正式制度原文为准。</p>' +
        '<ol><li>考勤与请假的正式制度原文：<span class="todo">待填</span></li>' +
        '<li>第 2 天对照正式制度，试着走一遍考勤／请假申请流程。</li></ol>' +
        '<div class="pager"><a href="#p03">上一篇</a><a href="#p05">下一篇</a></div>' +
        '<a class="linkcard" href="https://example.com/policy">公司制度</a>',
    },
    {
      id: 'p05',
      title: '第一周任务清单',
      body: '<p>完成入职任务清单。</p>',
    },
    {
      id: 'p06',
      title: '认识团队与沟通方式',
      body: '<p>认识你的带教老师与团队成员。</p>',
    },
    {
      id: 'p07',
      title: '常见问题 FAQ',
      body: '<p>常见问题：忘记打卡怎么办？请假找谁批？</p>',
    },
    {
      id: 'p08',
      title: '第一周结束：确认与反馈',
      body: '<p>第一周结束时找 HR 确认。</p>',
    },
  ];
  return (
    '<!doctype html><html><head><title>入社培训 · 新人第一周</title></head><body>' +
    sections
      .map(
        (s) =>
          `<section class="static-doc" id="${s.id}"><h2>${s.title}</h2>${s.body}</section>`
      )
      .join('') +
    '</body></html>'
  );
}

const docSections = buildDocSections([
  {
    key: 'html/test.html',
    title: '入社培训 · 新人第一周',
    content: makeDocHtml(),
  },
]);

test('parseHtmlSections：9 个 section、标题与纯文本、链接、待填', () => {
  const parsed = parseHtmlSections(makeDocHtml());
  assert.equal(parsed.length, 9);
  assert.deepEqual(
    parsed.map((s) => s.sectionId),
    ['p00', 'p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08']
  );
  const p04 = parsed[4];
  assert.equal(p04.sectionTitle, '考勤、请假与日常制度速览');
  assert.ok(p04.text.includes('请假怎么提'));
  assert.ok(p04.text.includes('待填'));
  // pager（上一篇/下一篇）不进正文，标签已剥干净
  assert.ok(!p04.text.includes('上一篇'));
  assert.ok(!p04.text.includes('<'));
  // 相关链接单独抽出，站内锚点不收
  assert.deepEqual(p04.links, [
    { text: '公司制度', href: 'https://example.com/policy' },
  ]);
  // 实体解码
  assert.ok(parsed[1].text.includes('身份证件 & 相关材料'));
  // 没有 static-doc section 的 HTML 返回空数组
  assert.deepEqual(
    parseHtmlSections('<html><body><p>hi</p></body></html>'),
    []
  );
});

test('docKeywordScoreList：“如何请假”命中 p04；“领导力”不误命中文档', () => {
  const scored = docKeywordScoreList(docSections, '如何请假');
  assert.ok(scored.length > 0);
  assert.equal(scored[0].slug, 'html/test.html#p04');
  assert.ok(scored[0].score >= 3);
  assert.deepEqual(docKeywordScoreList(docSections, '领导力'), []);
  assert.deepEqual(docKeywordScoreList(docSections, '今天天气'), []);
});

test('callJevRouting：意图加 doc_info，文档候选并行打分', async () => {
  let sentPayload: any;
  const stub = {
    postJson: async (_url: string, payload: unknown) => {
      sentPayload = payload;
      return {
        status: 200,
        body: JSON.stringify({
          answers: {
            intent: { type: 'choice', choice: 'doc_info', confidence: 0.9 },
            docrel_0: { type: 'noul', noul: 0.95 },
            docrel_1: { type: 'noul', noul: 0.3 },
          },
        }),
      };
    },
  };
  const p04 = docSections.find((s: any) => s.sectionId === 'p04')!;
  const p07 = docSections.find((s: any) => s.sectionId === 'p07')!;
  const res = await callJevRouting(
    {
      apiKey: 'test-key',
      query: '如何请假',
      candidates: [],
      docCandidates: [p04, p07],
    },
    stub
  );
  assert.ok(res);
  assert.equal(res.intent, 'doc_info');
  assert.equal(isDocIntent(res), true);
  assert.equal(isOffTopicIntent(res), false);
  assert.deepEqual(Object.keys(sentPayload.questions.intent.criteria), [
    'recommend',
    'course_info',
    'study_plan',
    'doc_info',
    'other',
  ]);
  assert.equal(sentPayload.questions.docrel_0.type, 'noul');
  assert.equal(sentPayload.questions.docrel_1.type, 'noul');
  assert.deepEqual(jevDocShortlist(res), [
    { docKey: 'html/test.html', sectionId: 'p04' },
  ]);
});

// --- runAssistantQuery 路由决策（fetch 与 Jev 均为桩） ---

const courseCatalog = [
  {
    slug: 'course-leadership',
    title: '从事到人：打造一流的团队执行力',
    description: '领导力培训视频，讲目标、标准与反馈。',
    categories: ['领导力'],
  },
];

const docUrl = (s: any) =>
  `/wiki/api/blog/html/${encodeURIComponent(s.docKey)}#${s.sectionId}`;

const resolveCourse = async (_slug: string) => ({
  link: 'https://example.com/course-leadership',
  type: 'video' as const,
});

function jevStub(intent: string, confidence: number, docNoul = 0.95) {
  return {
    postJson: async () => ({
      status: 200,
      body: JSON.stringify({
        answers: {
          intent: { type: 'choice', choice: intent, confidence },
          rel_0: { type: 'noul', noul: 0.91 },
          docrel_0: { type: 'noul', noul: docNoul },
          docrel_1: { type: 'noul', noul: 0.3 },
        },
      }),
    }),
  };
}

/** 桩 LLM：按 system prompt 区分课程推荐与文档回答，并计数。 */
function fetchStub() {
  let calls = 0;
  let docPrompt = '';
  const stub = async (_url: any, init: any) => {
    calls++;
    const body = JSON.parse(String(init?.body ?? '{}'));
    const system = String(body.messages?.[0]?.content ?? '');
    if (system.includes('回答文档问题')) {
      docPrompt = system;
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  '根据《入社培训 · 新人第一周》第 p04 节「考勤、请假与日常制度速览」，请假先读员工手册，正式制度以原文为准。',
              },
            },
          ],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ slugs: ['course-leadership'] }),
            },
          },
        ],
      }),
    };
  };
  return {
    stub,
    count: () => calls,
    docPrompt: () => docPrompt,
  };
}

async function withFetch<T>(stub: any, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  (globalThis as any).fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('runAssistantQuery：doc_info 意图走文档，答案 + #p04 来源链接', async () => {
  const f = fetchStub();
  const res = await withFetch(f.stub, () =>
    runAssistantQuery({
      query: '如何请假',
      catalog: courseCatalog,
      docSections,
      resolveCourse,
      docSectionUrl: docUrl,
      jevKey: 'test-key',
      baseUrl: 'https://magpie.test/v1',
      apiKey: 'test-key',
      jevTransport: jevStub('doc_info', 0.9),
    })
  );
  assert.equal(res.mode, 'doc');
  assert.equal(res.found, true);
  assert.ok(res.answer?.includes('p04'));
  assert.equal(res.sources?.length, 1);
  assert.ok(res.sources?.[0].url.endsWith('#p04'));
  assert.equal(res.routedBy, 'jev');
  // 文档回答的 prompt 要求只按原文、待填如实说
  assert.ok(f.docPrompt().includes('待填'));
});

test('runAssistantQuery：意图 other 但文档有命中时仍走文档', async () => {
  const f = fetchStub();
  const res = await withFetch(f.stub, () =>
    runAssistantQuery({
      query: '如何请假',
      catalog: courseCatalog,
      docSections,
      resolveCourse,
      docSectionUrl: docUrl,
      jevKey: 'test-key',
      baseUrl: 'https://magpie.test/v1',
      apiKey: 'test-key',
      jevTransport: jevStub('other', 0.95),
    })
  );
  assert.equal(res.mode, 'doc');
  assert.equal(res.found, true);
});

test('runAssistantQuery：意图 other 且文档无命中时直接查不到、不调 LLM', async () => {
  const f = fetchStub();
  const res = await withFetch(f.stub, () =>
    runAssistantQuery({
      query: '今天天气怎么样？',
      catalog: courseCatalog,
      docSections,
      resolveCourse,
      docSectionUrl: docUrl,
      jevKey: 'test-key',
      baseUrl: 'https://magpie.test/v1',
      apiKey: 'test-key',
      // 预筛会把“怎么”gram 命中的 p04 送给 Jev 粗筛，Jev 打低分（0.1）
      // 才是“文档无命中”的情形
      jevTransport: jevStub('other', 0.95, 0.1),
    })
  );
  assert.equal(res.found, false);
  assert.equal(res.routedBy, 'jev');
  assert.equal(f.count(), 0);
});

test('runAssistantQuery：领导力仍走课程链路，不受文档影响', async () => {
  const f = fetchStub();
  const res = await withFetch(f.stub, () =>
    runAssistantQuery({
      query: '我想学领导力，有什么课程推荐？',
      catalog: courseCatalog,
      docSections,
      resolveCourse,
      docSectionUrl: docUrl,
      jevKey: 'test-key',
      baseUrl: 'https://magpie.test/v1',
      apiKey: 'test-key',
      jevTransport: jevStub('recommend', 1.0),
    })
  );
  assert.equal(res.mode, 'ai');
  assert.equal(res.found, true);
  assert.deepEqual(
    res.courses.map((c: any) => c.slug),
    ['course-leadership']
  );
});

test('runAssistantQuery：无 Jev 时请假走关键词兜底，LLM 失败退回原文摘录', async () => {
  const failingFetch = async () => ({ ok: false, json: async () => ({}) });
  const res = await withFetch(failingFetch, () =>
    runAssistantQuery({
      query: '如何请假',
      catalog: courseCatalog,
      docSections,
      resolveCourse,
      docSectionUrl: docUrl,
      jevKey: '',
      baseUrl: 'https://magpie.test/v1',
      apiKey: 'test-key',
    })
  );
  assert.equal(res.mode, 'doc');
  assert.equal(res.found, true);
  // 摘录是原文逐字引用：含请假关键词与待填标记
  assert.ok(res.answer?.includes('请假'));
  assert.ok(res.answer?.includes('待填'));
  assert.ok(res.sources?.[0].url.endsWith('#p04'));
});
