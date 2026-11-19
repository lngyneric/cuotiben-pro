#!/usr/bin/env python3
"""从静态页 ivd-knowledge-tree.html 里抽出 TREE JSON。

只用 Python 标准库。TREE 是唯一事实来源：不手工改抽出的 JSON，
静态页更新后重跑本脚本即可。

用法：
  python3 scripts/extract_ivd_tree.py <html路径> [输出路径]
  默认输出 src/content/graph/ivd-tree.json（相对仓库根目录）。

同时校验：NODES / EDGES 两份派生数组的节点数与 TREE domains 展开一致，
不一致即报错退出（静态页本身的数据问题，不要悄悄吞掉）。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_OUT = os.path.join(ROOT, "src", "content", "graph", "ivd-tree.json")


def extract_json(html, name, opener):
    """从 JS 源码里按括号配对抽出 name 后面的 JSON 字面量。"""
    i = html.index(name)
    j = html.index(opener, i)
    closer = "}" if opener == "{" else "]"
    depth = 0
    k = j
    in_str = False
    esc = False
    while k < len(html):
        ch = html[k]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch in "{[":
                depth += 1
            elif ch in "}]":
                depth -= 1
                if depth == 0:
                    if ch != closer:
                        raise ValueError(f"{name}：括号不配对")
                    return html[j : k + 1]
        k += 1
    raise ValueError(f"{name}：括号未闭合")


def fail(msg):
    print(f"抽取失败：{msg}", file=sys.stderr)
    sys.exit(1)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    html_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    try:
        with open(html_path, encoding="utf-8") as f:
            html = f.read()
    except OSError as e:
        fail(f"读不到静态页 {html_path}：{e}")
    try:
        tree = json.loads(extract_json(html, "const TREE =", "{"))
        nodes = json.loads(extract_json(html, "NODES =", "["))
        edges = json.loads(extract_json(html, "EDGES =", "["))
    except (ValueError, json.JSONDecodeError) as e:
        fail(str(e))

    tree_nodes = [n for d in tree.get("domains", []) for n in d.get("nodes", [])]
    if len(tree_nodes) != len(nodes):
        fail(
            f"TREE domains 展开 {len(tree_nodes)} 个节点，"
            f"NODES 数组 {len(nodes)} 个，不一致"
        )
    tree_ids = {n["id"] for n in tree_nodes}
    flat_ids = {n["id"] for n in nodes}
    if tree_ids != flat_ids:
        fail(f"TREE 与 NODES 的节点 id 集合不一致：差集 {tree_ids ^ flat_ids}")
    edge_nodes = {e["source"] for e in edges} | {e["target"] for e in edges}
    if not edge_nodes <= tree_ids:
        fail(f"EDGES 引用了 TREE 外的节点：{sorted(edge_nodes - tree_ids)}")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(tree, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(
        f"已抽出 TREE：{len(tree.get('domains', []))} 个领域、"
        f"{len(tree_nodes)} 个节点、{len(edges)} 条边、"
        f"{sum(len(n.get('courses', [])) for n in tree_nodes)} 门课 → {out_path}"
    )


if __name__ == "__main__":
    main()
