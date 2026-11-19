#!/usr/bin/env python3
"""从 TREE 骨架生成 wiki 知识图谱 graph.json。

模式复用入社培训本体（graph.json：{ontology, version, date, scope,
source, counts, nodes, edges}；节点 {id, label, class, data}；
边 {source, property, target}，可带 data）。

输入：
  src/content/graph/ivd-tree.json（必需；extract_ivd_tree.py 的产物）
  --inputs <inputs.json>（可选；export_wiki_graph_inputs.py 的产物）
    没有 inputs 也能跑：课程 status 记“未知”、文档记“未匹配”，
    validate 会报 WARN，不静默当成已发布或已匹配。
输出：src/content/graph/graph.json

角色剪裁定义（docs/wiki-graph-ontology.md 第 3 节）：
  销售 = 4 个商务域全部节点；应用 = 9 个检验技术域全部节点；
  客服 = learning_paths.service_engineer 路径节点（TREE 无专属客服节点）。
文档挂接（同文档 4.2 节）：分类“新人入学”→通识基础领域；
其余按 keywords 与节点名/keyTopics 词面交集；挂不上进未匹配清单。
"""
import json
import os
import re
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GRAPH_DIR = os.path.join(ROOT, "src", "content", "graph")
TREE_PATH = os.path.join(GRAPH_DIR, "ivd-tree.json")
OUT_PATH = os.path.join(GRAPH_DIR, "graph.json")

SALES_DOMAINS = {
    "market_landscape",
    "sales_strategy",
    "product_positioning",
    "business_skills",
}
APPLICATION_DOMAINS = {
    "general",
    "hematology",
    "urinalysis",
    "coagulation",
    "immunoassay",
    "biochemistry",
    "molecular",
    "molecular_poct",
    "flow_cytometry_cn",
}
ROLE_LABELS = {
    "sales": "销售",
    "application": "应用",
    "service": "客服",
}
ROLE_NOTES = {
    "sales": "4 个商务域全部节点（恰好等于 metadata.view == 'sales' 的 13 个节点）",
    "application": "9 个检验技术域全部节点（26 个技术节点）",
    "service": "服务工程师路径节点（TREE 无专属客服节点，以此路径充当客服视图）",
}


def split_keywords(text):
    if not text:
        return []
    return [t for t in re.split(r"[,，、；; ]+", text) if t]


def fail(msg):
    print(f"生成失败：{msg}", file=sys.stderr)
    sys.exit(1)


def main():
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--inputs", default=None)
    ap.add_argument("--tree", default=TREE_PATH)
    ap.add_argument("--out", default=OUT_PATH)
    args = ap.parse_args()

    try:
        with open(args.tree, encoding="utf-8") as f:
            tree = json.load(f)
    except OSError as e:
        fail(f"读不到 {args.tree}：{e}（先跑 extract_ivd_tree.py）")

    posts = {}
    docs = []
    if args.inputs:
        try:
            with open(args.inputs, encoding="utf-8") as f:
                inputs = json.load(f)
        except OSError as e:
            fail(f"读不到 inputs {args.inputs}：{e}")
        posts = {p["slug"]: p for p in inputs.get("posts", [])}
        docs = inputs.get("docs", [])

    nodes = []
    edges = []
    unmatched_courses = []
    unmatched_docs = []

    def add_node(node_id, label, cls, data):
        nodes.append({"id": node_id, "label": label, "class": cls, "data": data})

    def add_edge(src, prop, tgt, data=None):
        e = {"source": src, "property": prop, "target": tgt}
        if data:
            e["data"] = data
        edges.append(e)

    # --- 领域与节点 ------------------------------------------------------
    domain_ids = {}
    node_domain = {}
    node_index = {}
    for d in tree.get("domains", []):
        did = f"domain:{d['id']}"
        domain_ids[d["id"]] = did
        add_node(
            did,
            d["name"],
            "Domain",
            {
                "title": d["name"],
                "color": d.get("color", ""),
                "description": d.get("description", ""),
            },
        )
        for n in d.get("nodes", []):
            nid = f"node:{n['id']}"
            node_domain[n["id"]] = d["id"]
            node_index[n["id"]] = n
            md = n.get("metadata", {})
            add_node(
                nid,
                n["name"],
                "KnowledgeNode",
                {
                    "title": n["name"],
                    "difficulty": n.get("difficulty"),
                    "estimatedHours": n.get("estimated_hours"),
                    "keyTopics": md.get("key_topics", []),
                    "instruments": md.get("instrument_models", []),
                    "parameters": md.get("test_parameters", []),
                    "clinicalApps": md.get("clinical_apps", []),
                    "regulations": md.get("regulations", []),
                    "salesKpi": md.get("sales_kpi", ""),
                    "sourcePpt": md.get("source_ppt", ""),
                    "audience": md.get("audience", ""),
                    "domainId": d["id"],
                },
            )
            add_edge(did, "domainHasNode", nid)

    # --- 课程 ------------------------------------------------------------
    seen_bids = set()
    for d in tree.get("domains", []):
        for n in d.get("nodes", []):
            for c in n.get("courses", []):
                bid = c["shifu_bid"]
                if bid in seen_bids:
                    fail(f"shifu_bid 重复：{bid}（G6）")
                seen_bids.add(bid)
                slug = f"course-{bid}"
                post = posts.get(slug)
                if post is None:
                    status = "未知" if not args.inputs else "未入库"
                    if args.inputs:
                        unmatched_courses.append(
                            {"bid": bid, "title": c["title"], "node": n["id"]}
                        )
                else:
                    status = (
                        "已发布" if post["status"] == "published" else "草稿"
                    )
                add_node(
                    f"course:{bid}",
                    c["title"],
                    "Course",
                    {
                        "title": c["title"],
                        "shifuBid": bid,
                        "slug": slug,
                        "status": status,
                        "postTitle": post["title"] if post else "",
                        "lessonCount": c.get("lesson_count", 0),
                        "keywords": c.get("keywords", ""),
                    },
                )
                add_edge(f"node:{n['id']}", "nodeHasCourse", f"course:{bid}")

    # --- 节点间边 --------------------------------------------------------
    for n in node_index.values():
        for tgt in n.get("prerequisites", []):
            add_edge(f"node:{n['id']}", "nodePrerequisite", f"node:{tgt}")
        for tgt in n.get("extends", []):
            add_edge(f"node:{n['id']}", "nodeExtends", f"node:{tgt}")
        for tgt in n.get("parallel", []):
            add_edge(f"node:{n['id']}", "nodeParallel", f"node:{tgt}")
    for rel in tree.get("cross_domain_relations", []):
        prop = {
            "prerequisites": "nodePrerequisite",
            "extends": "nodeExtends",
            "parallel": "nodeParallel",
        }.get(rel.get("type"), "nodeParallel")
        add_edge(
            f"node:{rel['from']}",
            prop,
            f"node:{rel['to']}",
            {"note": rel.get("note", ""), "crossDomain": True},
        )

    # --- 角色视图 --------------------------------------------------------
    role_nodes = {
        "sales": [
            n["id"]
            for n in node_index.values()
            if node_domain[n["id"]] in SALES_DOMAINS
        ],
        "application": [
            n["id"]
            for n in node_index.values()
            if node_domain[n["id"]] in APPLICATION_DOMAINS
        ],
        "service": list(
            tree.get("learning_paths", {}).get("service_engineer", {}).get("nodes", [])
        ),
    }
    for role, label in ROLE_LABELS.items():
        rid = f"role:{role}"
        add_node(
            rid, label, "RoleView", {"role": label, "note": ROLE_NOTES[role]}
        )
        for dom in sorted(
            {node_domain[nid] for nid in role_nodes[role] if nid in node_domain}
        ):
            add_edge(rid, "roleIncludesDomain", f"domain:{dom}")
        for nid in role_nodes[role]:
            if nid in node_domain:
                add_edge(rid, "roleIncludesNode", f"node:{nid}")

    # --- 带教路径（首批只记节点归属，阶段轴第二批） ----------------------
    for key, path in tree.get("learning_paths", {}).items():
        pid = f"path:{key}"
        add_node(
            pid,
            path.get("name", key),
            "LearningPath",
            {
                "title": path.get("name", key),
                "estimatedTotalHours": path.get("estimated_total_hours"),
            },
        )
        for nid in path.get("nodes", []):
            if nid in node_domain:
                add_edge(pid, "pathIncludesNode", f"node:{nid}")

    # --- 文档挂接 --------------------------------------------------------
    for doc in docs:
        doc_id = f"doc:{doc['docKey']}#{doc['sectionId']}"
        add_node(
            doc_id,
            doc["sectionTitle"],
            "DocSection",
            {
                "title": doc["sectionTitle"],
                "docKey": doc["docKey"],
                "sectionId": doc["sectionId"],
                "docTitle": doc["docTitle"],
                "category": doc.get("category", ""),
                "keywords": doc.get("keywords", ""),
                "url": doc.get("url", ""),
            },
        )
        matched = False
        if doc.get("category") == "新人入学":
            add_edge(
                "domain:general",
                "domainHasDoc",
                doc_id,
                {"matchReason": "分类=新人入学→通识基础"},
            )
            matched = True
        else:
            kws = set(split_keywords(doc.get("keywords", "")))
            for n in node_index.values():
                hay = n["name"] + " " + " ".join(
                    (n.get("metadata", {}) or {}).get("key_topics", [])
                )
                hits = [k for k in kws if k and k in hay]
                if hits:
                    add_edge(
                        f"node:{n['id']}",
                        "nodeHasDoc",
                        doc_id,
                        {"matchReason": f"关键词命中：{'、'.join(hits)}"},
                    )
                    matched = True
        if not matched:
            unmatched_docs.append(
                {"sectionId": doc["sectionId"], "title": doc["sectionTitle"]}
            )

    # --- SharePoint 锚点（首批只含已验证的站点＋库，全文未抽） -----------
    add_node(
        "sp:site:zlsw",
        "战略参考资料（ZLSW）",
        "SharePointSource",
        {
            "title": "战略参考资料",
            "siteUrl": "https://sysmexcn.sharepoint.com/sites/ZLSW",
            "extractionStatus": "未抽取",
            "itemCount": None,
            "lastSeen": "2026-11-19",
        },
    )
    add_node(
        "sp:lib:zlsw-documents",
        "Documents",
        "SharePointSource",
        {
            "title": "Documents",
            "siteUrl": "https://sysmexcn.sharepoint.com/sites/ZLSW/Shared Documents",
            "driveId": "b!aaVeCCCvRECTX-pDWg6h8mQilLKLXWlPrWTAUp_AIVJIDZCKhIURSr-S9OmygXh_",
            "extractionStatus": "未抽取",
            "itemCount": None,
            "lastSeen": "2026-11-19",
        },
    )
    add_edge("sp:site:zlsw", "siteHasLibrary", "sp:lib:zlsw-documents")

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    graph = {
        "ontology": "Wiki 知识图谱本体",
        "version": "1.0",
        "date": now[:10],
        "scope": "IVD 检验医学知识体系（TREE 骨架）＋ wiki 课程与文档；首批领域轴＋角色剪裁",
        "source": "build_wiki_graph.py（依据：src/content/graph/ivd-tree.json、"
        "wiki-graph-inputs.json、docs/wiki-graph-ontology.md）",
        "generatedAt": now,
        "treeVersion": tree.get("version", ""),
        "counts": {
            "nodes": len(nodes),
            "edges": len(edges),
            "domains": len(domain_ids),
            "knowledgeNodes": len(node_index),
            "courses": len(seen_bids),
            "docs": len(docs),
            "unmatchedCourses": len(unmatched_courses),
            "unmatchedDocs": len(unmatched_docs),
            "note": "边数含先修／进阶／并行／跨领域／角色／路径／文档挂接的展开计数。",
        },
        "unmatchedCourses": unmatched_courses,
        "unmatchedDocs": unmatched_docs,
        "nodes": nodes,
        "edges": edges,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(graph, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(
        f"已生成图谱：{len(nodes)} 节点、{len(edges)} 边；"
        f"课程 {len(seen_bids)} 门（未入库 {len(unmatched_courses)}）、"
        f"文档 {len(docs)} 篇（未匹配 {len(unmatched_docs)}）→ {args.out}"
    )


if __name__ == "__main__":
    main()
