import assert from 'node:assert/strict';
import { test } from 'node:test';

// 导航＋意图优化：PPT 页签的纯函数（意图抽取、outline 合并、习惯存取）。
// 不碰 DOM、不调接口，直接用 tsx 跑。

const shared = await import('../src/routes/ai-assistant/-ppt-shared');
const { parsePptIntent, mergeOutlinePagesToOne, loadPptPrefs, savePptPrefs } =
  shared;

test('parsePptIntent: 做一页、不要标题页', () => {
  assert.deepEqual(parsePptIntent('做一页，不要标题页'), {
    nSlides: 1,
    titlePage: false,
  });
});

test('parsePptIntent: 页数填 3（显式计数优先）', () => {
  assert.deepEqual(parsePptIntent('第 1 页封面\n第 2 页总结\n第 3 页计划\n页数填 3，选标准模式'), {
    nSlides: 3,
  });
});

test('parsePptIntent: 第 N 页取最大页码，不取首个', () => {
  assert.deepEqual(
    parsePptIntent('第 1 页 封面……第 2 页 上半年总结……第 3 页 下半年计划'),
    { nSlides: 3 }
  );
  // 只有“第 1 页”时就是 1 页。
  assert.deepEqual(parsePptIntent('第 1 页是封面'), { nSlides: 1 });
});

test('parsePptIntent: 做 6 页、保留标题页；共 5 页；裸数字', () => {
  assert.deepEqual(parsePptIntent('做 6 页，保留标题页'), {
    nSlides: 6,
    titlePage: true,
  });
  assert.deepEqual(parsePptIntent('一共 5 页'), { nSlides: 5 });
  assert.deepEqual(parsePptIntent('帮我做 3 页汇报'), { nSlides: 3 });
  assert.deepEqual(parsePptIntent('做一页'), { nSlides: 1 });
});

test('parsePptIntent: 否定说法优先，不猜', () => {
  assert.deepEqual(parsePptIntent('不要做封面'), { titlePage: false });
  assert.deepEqual(parsePptIntent('不用标题页'), { titlePage: false });
  assert.deepEqual(parsePptIntent('帮我做个汇报'), {});
  assert.deepEqual(parsePptIntent(''), {});
});

test('mergeOutlinePagesToOne: 多页并成 1 页，要点与来源都并上', () => {
  const pages = [
    {
      pageNo: 1,
      title: '第一页',
      points: ['要点 A'],
      layout: 'B',
      layoutReason: '左文右图',
      sources: [{ sourceId: 's1', sourceKind: 'upload_text', locator: 'p1' }],
      primaryKind: 'upload_text',
    },
    {
      pageNo: 2,
      title: '第二页',
      points: ['要点 B', '要点 C'],
      layout: 'D',
      layoutReason: '三栏对比',
      sources: [{ sourceId: 's1', sourceKind: 'upload_text', locator: 'p2' }],
      primaryKind: 'upload_text',
    },
  ];
  const merged = mergeOutlinePagesToOne(pages);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].pageNo, 1);
  assert.equal(merged[0].title, '第一页');
  assert.deepEqual(merged[0].points, ['要点 A', '要点 B', '要点 C']);
  assert.equal(merged[0].sources.length, 2);
  assert.match(merged[0].note ?? '', /由 2 页合并/);
  // 1 页时原样返回。
  assert.deepEqual(mergeOutlinePagesToOne(merged), merged);
});

test('习惯存取：node 环境下无 window，不抛错、读回默认', () => {
  assert.deepEqual(loadPptPrefs(), {});
  // save 在服务端/测试环境是空操作，不抛错。
  savePptPrefs({ nSlides: 1, titlePage: false, mode: 'standard' });
  assert.deepEqual(loadPptPrefs(), {});
});
