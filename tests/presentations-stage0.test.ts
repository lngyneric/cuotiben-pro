// 阶段 0 地基单测：版式注册表、主题常量、element_id、留痕字段结构。
// 纯函数，不碰数据库、不调 Presenton。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildElementIndex,
  elementIdFor,
  stampElementIds,
} from '../src/modules/presentations/element-index';
import {
  parseElementIndex,
  parseLayoutAssignments,
  parsePageSourceRefs,
  serializeJobMeta,
} from '../src/modules/presentations/job-meta';
import {
  allSlots,
  buildThemeInstructions,
  findSlot,
  isLayoutCode,
  LAYOUT_CODES,
  LAYOUTS,
  PPT_LOGO_SLOT,
  PPT_SLIDE_SIZE_IN,
  PPT_THEME_COLORS,
  PPT_THEME_VERSION,
  SLOT_TYPES,
  suggestLayout,
} from '../src/modules/presentations/layouts';
import { buildFixturePptx } from './pptx-fixture';

test('stage0 layouts: 8 layouts A-H, slot types legal, rects inside the slide', () => {
  assert.deepEqual([...LAYOUT_CODES].sort(), [
    'A',
    'B',
    'C',
    'D',
    'E',
    'F',
    'G',
    'H',
  ]);
  for (const code of LAYOUT_CODES) {
    const def = LAYOUTS[code];
    assert.ok(def.slots.length >= 5, `${code} has too few slots`);
    const ids = new Set<string>();
    for (const s of allSlots(code)) {
      assert.ok(!ids.has(s.id), `${code} duplicate slot ${s.id}`);
      ids.add(s.id);
      assert.ok(
        (SLOT_TYPES as readonly string[]).includes(s.type),
        `${code}/${s.id} bad type ${s.type}`
      );
      const r = s.rectIn;
      assert.ok(
        r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0,
        `${code}/${s.id} bad rect`
      );
      // 设计稿 F 的 step_4 本身就伸出页边 0.02 英寸（10.20+3.15=13.35 > 13.33），
      // 注册表如实抄设计稿值，容差 0.05 英寸。
      assert.ok(
        r.x + r.width <= PPT_SLIDE_SIZE_IN.width + 0.05 &&
          r.y + r.height <= PPT_SLIDE_SIZE_IN.height + 0.01,
        `${code}/${s.id} rect outside slide`
      );
      const f = s.rect;
      assert.ok(
        Math.abs(f.x - r.x / PPT_SLIDE_SIZE_IN.width) < 0.001 &&
          Math.abs(f.width - r.width / PPT_SLIDE_SIZE_IN.width) < 0.001,
        `${code}/${s.id} fraction mismatch`
      );
    }
  }
  // 版式代号与清单一致；每版式至少含一个标题槽与一个正文槽。
  assert.equal(LAYOUTS.A.name, '数据条+四卡');
  assert.equal(LAYOUTS.B.name, '左文右图');
  assert.equal(LAYOUTS.C.name, '二二网格');
  assert.equal(LAYOUTS.D.name, '三栏');
  assert.equal(LAYOUTS.E.name, '上图下文');
  assert.equal(LAYOUTS.F.name, '横向步骤时间线');
  assert.equal(LAYOUTS.G.name, '左1右2分列');
  assert.equal(LAYOUTS.H.name, '左右平分、左列分上下');
  for (const code of LAYOUT_CODES) {
    const types = new Set(allSlots(code).map((s) => s.type));
    assert.ok(
      types.has('title') && types.has('body'),
      `${code} lacks title/body`
    );
  }
  // A 有 3 个数字卡；B 有主图；F 的配图条是可选槽；G 左右 1:2。
  assert.equal(LAYOUTS.A.slots.filter((s) => s.type === 'kpi_card').length, 3);
  assert.equal(findSlot('B', 'main_image')?.type, 'main_image');
  assert.equal(findSlot('F', 'image_strip')?.optional, true);
  assert.ok(isLayoutCode('G') && !isLayoutCode('Z'));
});

test('stage0 theme: exactly the 8 checklist colors, single injection point', () => {
  assert.deepEqual(Object.values(PPT_THEME_COLORS), [
    '#2F5597',
    '#003266',
    '#005B9F',
    '#27AE60',
    '#ED7D31',
    '#9DC3E6',
    '#D9DEE6',
    '#F7F9FC',
  ]);
  assert.equal(PPT_THEME_VERSION, '2026-11-v1');
  // Logo 位与设计稿总览页一致：右上角 1.48×0.52 英寸。
  assert.deepEqual(PPT_LOGO_SLOT, {
    x: 11.55,
    y: 0.12,
    width: 1.48,
    height: 0.52,
  });
  const block = buildThemeInstructions();
  for (const hex of Object.values(PPT_THEME_COLORS))
    assert.ok(block.includes(hex), `theme block missing ${hex}`);
  assert.ok(block.includes('11.55') && block.includes('1.48'));
  assert.ok(block.includes(PPT_THEME_VERSION));
});

test('stage0 suggestLayout: deterministic draft heuristic with reasons', () => {
  assert.equal(suggestLayout({ kpiCount: 3, pointCount: 4 }).layout, 'A');
  assert.equal(suggestLayout({ stepCount: 4 }).layout, 'F');
  assert.equal(
    suggestLayout({ pointCount: 4, hasSmallImages: true }).layout,
    'C'
  );
  assert.equal(suggestLayout({ pointCount: 3 }).layout, 'D');
  assert.equal(suggestLayout({ stepCount: 3, hasMainImage: true }).layout, 'B');
  assert.equal(suggestLayout({ twoBlocks: true }).layout, 'H');
  assert.equal(
    suggestLayout({ hasMainImage: true, pointCount: 2 }).layout,
    'G'
  );
  assert.equal(suggestLayout({ hasMainImage: true }).layout, 'E');
  assert.equal(suggestLayout({}).layout, 'B');
  assert.ok(suggestLayout({}).reason.length > 0);
});

test('stage0 element ids: stamp a real pptx, list per page, no duplicates', () => {
  for (const method of [0, 8] as const) {
    const fixture = buildFixturePptx(method);
    const index = buildElementIndex(fixture);
    assert.ok(index, `fixture (method ${method}) must parse`);
    assert.equal(index!.pages.length, 2);
    assert.deepEqual(
      index!.pages[0].elements.map((e) => [
        e.elementId,
        e.type,
        e.name,
        e.text,
      ]),
      [
        ['el-p1-1', 'text', 'Title', 'Hello Title'],
        ['el-p1-2', 'image', 'Picture 1', ''],
        ['el-p1-3', 'chart', 'Chart 1', ''],
      ]
    );
    assert.deepEqual(
      index!.pages[1].elements.map((e) => [
        e.elementId,
        e.type,
        e.name,
        e.text,
      ]),
      [
        ['el-p2-1', 'text', 'Body', 'Second page'],
        ['el-p2-2', 'shape', 'Rectangle 5', ''],
      ]
    );
    const stamped = stampElementIds(fixture);
    assert.ok(stamped, `fixture (method ${method}) must stamp`);
    // STORE 存放时可直接在字节里看到改写后的名字；DEFLATE 存放时看重读索引。
    if (method === 0) {
      const xml = stamped!.bytes.toString('utf-8');
      assert.ok(
        xml.includes('name="el-p1-1"') && xml.includes('name="el-p2-2"')
      );
      assert.ok(
        !xml.includes('name="Title"') && !xml.includes('name="Chart 1"')
      );
    }
    const reread = buildElementIndex(stamped!.bytes);
    assert.ok(reread);
    assert.deepEqual(
      reread!.pages.map((p) =>
        p.elements.map((e) => [e.elementId, e.type, e.text])
      ),
      index!.pages.map((p) =>
        p.elements.map((e) => [e.elementId, e.type, e.text])
      )
    );
    assert.deepEqual(
      reread!.pages.flatMap((p) => p.elements.map((e) => e.name)),
      index!.pages.flatMap((p) => p.elements.map((e) => e.elementId))
    );
    // 幂等：再盖一次得到同一组 ID（name 字段本身已是 el-id，不再比它）。
    const restamped = stampElementIds(stamped!.bytes);
    assert.ok(restamped);
    assert.deepEqual(
      restamped!.index.pages.map((p) =>
        p.elements.map((e) => [e.elementId, e.type, e.text])
      ),
      index!.pages.map((p) =>
        p.elements.map((e) => [e.elementId, e.type, e.text])
      )
    );
    assert.deepEqual(stamped!.bytes, restamped!.bytes);
    assert.equal(elementIdFor(2, 3), 'el-p2-3');
  }
});

test('stage0 element ids: non-pptx bytes pass through untouched', () => {
  assert.equal(buildElementIndex(Buffer.from('not a pptx')), null);
  assert.equal(stampElementIds(Buffer.from('not a pptx')), null);
  assert.equal(
    buildElementIndex(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.from('fake-pptx-content'),
      ])
    ),
    null
  );
});

test('stage0 provenance: layoutAssignments / pageSourceRefs / elementIndex round-trip and reject bad shapes', () => {
  const layouts = [{ pageNo: 1, layout: 'B', reason: '左文右图' }];
  assert.deepEqual(parseLayoutAssignments(serializeJobMeta(layouts)), layouts);
  assert.equal(
    parseLayoutAssignments('[{"pageNo":1,"layout":"Z","reason":"x"}]'),
    null
  );
  assert.equal(
    parseLayoutAssignments('[{"pageNo":0,"layout":"B","reason":"x"}]'),
    null
  );
  assert.equal(parseLayoutAssignments('not json'), null);
  assert.equal(parseLayoutAssignments(null), null);

  const refs = [
    {
      pageNo: 2,
      sources: [
        { sourceId: 'src-1', sourceKind: 'upload_text', locator: 'para 3' },
        { sourceId: 'kb-9', sourceKind: 'wiki_kb', locator: 'entry kb-9' },
      ],
    },
  ];
  assert.deepEqual(parsePageSourceRefs(serializeJobMeta(refs)), refs);
  assert.equal(
    parsePageSourceRefs(
      '[{"pageNo":1,"sources":[{"sourceId":"s","sourceKind":"web","locator":"x"}]}]'
    ),
    null
  );
  assert.equal(
    parsePageSourceRefs(
      '[{"pageNo":1,"sources":[{"sourceId":"","sourceKind":"upload_text","locator":"x"}]}]'
    ),
    null
  );

  const index = buildElementIndex(buildFixturePptx())!;
  assert.deepEqual(parseElementIndex(serializeJobMeta(index)), index);
  const dup = structuredClone(index);
  dup.pages[1].elements[0].elementId = 'el-p1-1';
  assert.equal(parseElementIndex(serializeJobMeta(dup)), null);
  assert.equal(parseElementIndex('{"version":2,"pages":[]}'), null);
  assert.equal(parseElementIndex(null), null);
});
