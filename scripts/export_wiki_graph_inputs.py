#!/usr/bin/env python3
"""导出 build_wiki_graph.py 用的实时输入（只读，不改库）。

输入：
  --db <blog.db 副本路径>            post 表 course-<bid> 的 slug/title/status
  --doc-index <doc-index.json 路径>  容器内 /app/data/doc-index.json 的副本
输出：一个 inputs JSON：{"posts": [...], "docs": [...]}
  posts: [{slug, title, status}]
  docs:  [{docKey, docTitle, category, keywords, sectionId, sectionTitle, url}]

docs 的 category/keywords 来自 blog_html_file 表（按 key 关联）；
doc-index.json 里只有 section 文本，没有分类与关键词。

用法（在服务器上对副本跑，或把副本拷回本地跑）：
  docker cp cuotiben-pro-blog:/app/data/blog.db /tmp/blog.db
  docker cp cuotiben-pro-blog:/app/data/doc-index.json /tmp/doc-index.json
  python3 scripts/export_wiki_graph_inputs.py --db /tmp/blog.db \\
      --doc-index /tmp/doc-index.json --out /tmp/wiki-graph-inputs.json
"""
import argparse
import json
import sqlite3
import sys
from urllib.parse import quote


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--doc-index", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    posts = [
        {"slug": slug, "title": title, "status": status}
        for slug, title, status in con.execute(
            "SELECT slug, title, status FROM post "
            "WHERE slug LIKE 'course-%' ORDER BY slug"
        )
    ]
    html_files = {
        key: {"title": title, "category": cat, "keywords": kw}
        for key, title, cat, kw in con.execute(
            "SELECT key, title, category, keywords FROM blog_html_file"
        )
    }
    con.close()

    with open(args.doc_index, encoding="utf-8") as f:
        index = json.load(f)
    docs = []
    for s in index.get("sections", []):
        # section 自带 docKey / docTitle / keywords（列表）；category 只有
        # blog_html_file 表里有，按 key 关联取。
        key = s.get("docKey", "")
        meta = html_files.get(key, {})
        kws = s.get("keywords", [])
        if isinstance(kws, list):
            kws = "，".join(kws)
        docs.append(
            {
                "docKey": key,
                "docTitle": s.get("docTitle", meta.get("title", "")),
                "category": meta.get("category", ""),
                "keywords": kws or meta.get("keywords", ""),
                "sectionId": s.get("sectionId", ""),
                "sectionTitle": s.get("sectionTitle", ""),
                # 文档链接与 blogHtmlUrl 同口径：/api/blog/html/ + 编码后的
                # key + #sectionId。key 本身带 html/ 前缀，绝不能再拼
                # /html/（曾因此产出 /html/html/… 的双前缀坏链）；base
                # 路径（/wiki）由页面 withAppBase 补，这里只给相对路径。
                "url": f"/api/blog/html/{quote(key, safe='')}#{s.get('sectionId', '')}" if key else "",
            }
        )
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"posts": posts, "docs": docs}, f, ensure_ascii=False, indent=2)
    print(f"已导出：{len(posts)} 门课、{len(docs)} 个文档 section → {args.out}")


if __name__ == "__main__":
    main()
