import assert from 'node:assert/strict';
import { test } from 'node:test';

// Wiki 知识图谱生成物校验：只读 src/content/graph/graph.json，
// 不读库、不读配置。生成脚本改了结构或数据，这里先报错。
const graph = (
  await import('@/content/graph/graph.json', {
    with: { type: 'json' },
  })
).default as {
  version: string;
  generatedAt: string;
  treeVersion: string;
  counts: Record<string, number | string>;
  unmatchedCourses: unknown[];
  unmatchedDocs: unknown[];
  nodes: {
    id: string;
    label: string;
    class: string;
    data: Record<string, unknown>;
  }[];
  edges: { source: string; property: string; target: string }[];
};

const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
const edgesBySource = new Map<string, typeof graph.edges>();
for (const e of graph.edges) {
  edgesBySource.set(e.source, [...(edgesBySource.get(e.source) ?? []), e]);
}

test('图谱骨架：13 域、39 节点、9 门课，与 TREE 一致', () => {
  assert.equal(graph.treeVersion, '1.0.1');
  assert.equal(graph.counts.domains, 13);
  assert.equal(graph.counts.knowledgeNodes, 39);
  assert.equal(graph.counts.courses, 9);
  assert.equal(graph.nodes.length, 81);
  assert.ok(graph.generatedAt);
});

test('G1：每个知识节点恰好属于一个领域', () => {
  const counts = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.property === 'domainHasNode')
      counts.set(e.target, (counts.get(e.target) ?? 0) + 1);
  }
  for (const n of graph.nodes) {
    if (n.class === 'KnowledgeNode') assert.equal(counts.get(n.id), 1, n.id);
  }
});

test('G3：边两端节点都存在；G6：shifu_bid 不重复', () => {
  for (const e of graph.edges) {
    assert.ok(nodesById.has(e.source), `悬空边起点 ${e.source}`);
    assert.ok(nodesById.has(e.target), `悬空边终点 ${e.target}`);
  }
  const bids = graph.nodes
    .filter((n) => n.class === 'Course')
    .map((n) => n.data.shifuBid);
  assert.equal(bids.length, new Set(bids).size);
});

test('G2：本次 9 门课全部已发布，0 未入库', () => {
  for (const n of graph.nodes) {
    if (n.class === 'Course') assert.equal(n.data.status, '已发布', n.id);
  }
  assert.deepEqual(graph.unmatchedCourses, []);
});

test('角色剪裁：销售 13、应用 26、客服 8 个节点', () => {
  const roleNodes = (role: string) =>
    (edgesBySource.get(`role:${role}`) ?? [])
      .filter((e) => e.property === 'roleIncludesNode')
      .map((e) => e.target);
  assert.equal(roleNodes('sales').length, 13);
  assert.equal(roleNodes('application').length, 26);
  assert.equal(roleNodes('service').length, 8);
  // 销售与应用不重叠
  const overlap = roleNodes('sales').filter((id) =>
    roleNodes('application').includes(id)
  );
  assert.deepEqual(overlap, []);
});

test('文档挂接：9 篇入社培训 section 全挂通识基础领域，0 未匹配', () => {
  const docs = (edgesBySource.get('domain:general') ?? []).filter(
    (e) => e.property === 'domainHasDoc'
  );
  assert.equal(docs.length, 9);
  assert.deepEqual(graph.unmatchedDocs, []);
});

test('节点间边与静态页 EDGES 一致：46 先修、20 进阶、31 并行', () => {
  const count = (prop: string) =>
    graph.edges.filter((e) => e.property === prop).length;
  assert.equal(count('nodePrerequisite'), 46);
  assert.equal(count('nodeExtends'), 20);
  assert.equal(count('nodeParallel'), 31);
});
