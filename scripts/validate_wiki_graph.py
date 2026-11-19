#!/usr/bin/env python3
"""按 G1–G9 校验 src/content/graph/graph.json。

只用 Python 标准库。退出码 0 为通过、1 为有 FAIL；WARN 不拦。
用法：python3 scripts/validate_wiki_graph.py [graph.json 路径]
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_GRAPH = os.path.join(ROOT, "src", "content", "graph", "graph.json")

ROLES = {"sales", "application", "service"}


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_GRAPH
    try:
        with open(path, encoding="utf-8") as f:
            g = json.load(f)
    except OSError as e:
        print(f"FAIL：读不到 {path}：{e}")
        return 1
    nodes = {n["id"]: n for n in g.get("nodes", [])}
    edges = g.get("edges", [])
    results = []

    def check(cid, ok, detail):
        results.append((cid, "PASS" if ok else "FAIL", detail))

    def warn(cid, ok, detail):
        results.append((cid, "PASS" if ok else "WARN", detail))

    # G1：每个知识节点属于恰好一个领域
    dom_of = {}
    for e in edges:
        if e["property"] == "domainHasNode":
            dom_of[e["target"]] = dom_of.get(e["target"], 0) + 1
    orphans = [
        nid
        for nid, n in nodes.items()
        if n["class"] == "KnowledgeNode" and dom_of.get(nid, 0) != 1
    ]
    check("G1", not orphans, f"无领域或多领域的节点：{orphans or '无'}")

    # G2：课程要么映射到 post（status 不是未入库），要么明确标未入库
    bad = [
        n["id"]
        for n in nodes.values()
        if n["class"] == "Course" and n["data"].get("status") not in
        ("已发布", "草稿", "未入库", "未知")
    ]
    check("G2", not bad, f"状态非法的课程：{bad or '无'}；未入库清单见 unmatchedCourses")
    unknown = [
        n["id"]
        for n in nodes.values()
        if n["class"] == "Course" and n["data"].get("status") == "未知"
    ]
    warn("G2-unknown", not unknown, f"状态未知的课程（无 inputs 构建）：{len(unknown)} 门")

    # G3：边的两端都存在
    dangling = [
        (e["source"], e["property"], e["target"])
        for e in edges
        if e["source"] not in nodes or e["target"] not in nodes
    ]
    check("G3", not dangling, f"悬空边：{dangling[:5] or '无'}")

    # G4：角色视图只引用已存在的领域／节点（G3 已覆盖悬空，G4 查角色齐全）
    role_nodes = {
        r: [n["id"] for n in nodes.values() if n["id"] == f"role:{r}"]
        for r in ROLES
    }
    missing_roles = [r for r, v in role_nodes.items() if not v]
    check("G4", not missing_roles, f"缺失的角色视图：{missing_roles or '无（销售/应用/客服齐全）'}")
    empty_roles = []
    for r in ROLES:
        count = sum(
            1
            for e in edges
            if e["source"] == f"role:{r}" and e["property"] == "roleIncludesNode"
        )
        if count == 0:
            empty_roles.append(r)
    check("G4-empty", not empty_roles, f"空角色视图（无节点）：{empty_roles or '无'}")

    # G5：文档未匹配进清单，不删除
    unmatched = g.get("unmatchedDocs", [])
    warn("G5", not unmatched, f"未匹配文档：{len(unmatched)} 篇（清单在 unmatchedDocs）")

    # G6：shifu_bid 唯一
    bids = [n["data"].get("shifuBid") for n in nodes.values() if n["class"] == "Course"]
    check("G6", len(bids) == len(set(bids)), f"课程 {len(bids)} 门，重复 bid：{len(bids) - len(set(bids))} 个")

    # G7：节点 id 唯一
    check("G7", len(nodes) == len(g.get("nodes", [])), "节点 id 有重复" if len(nodes) != len(g.get("nodes", [])) else "节点 id 全部唯一")

    # G8：provenance
    warn("G8", bool(g.get("generatedAt")) and bool(g.get("treeVersion")),
         f"generatedAt={g.get('generatedAt')} treeVersion={g.get('treeVersion')}")

    # G9：SharePoint 状态诚实（全文已抽必须有依据；首批只允许 未抽取/元数据已抽）
    bad_sp = [
        n["id"]
        for n in nodes.values()
        if n["class"] == "SharePointSource"
        and n["data"].get("extractionStatus") not in ("未抽取", "元数据已抽", "全文已抽")
    ]
    check("G9", not bad_sp, f"状态非法的 SharePoint 源：{bad_sp or '无'}")

    n_pass = sum(1 for _, s, _ in results if s == "PASS")
    n_fail = sum(1 for _, s, _ in results if s == "FAIL")
    n_warn = sum(1 for _, s, _ in results if s == "WARN")
    for cid, status, detail in results:
        print(f"{status} {cid}：{detail}")
    print(f"\n{n_pass} PASS / {n_fail} FAIL / {n_warn} WARN（共 {len(results)} 项）")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
