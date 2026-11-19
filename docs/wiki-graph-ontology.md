# Wiki 知识图谱 Ontology 与 SharePoint 抽取计划

> 2026-11-19。基于 2026-11-18 的《wiki-graph-design.md》（分支设计）落地。
> 首批只做**领域轴＋角色剪裁**；带教阶段轴与人员轴第二批。
> 本文档是设计＋维护手册；机器可读的 schema 与图谱在 `src/content/graph/`，
> 生成脚本在 `scripts/`（`extract_ivd_tree.py`、`build_wiki_graph.py`、
> `validate_wiki_graph.py`）。

## 1. 现状与来源（逐项可追溯，不编造）

| 来源              | 位置 / 形态                                                                                            | 规模（2026-11-19 实测）                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| TREE 骨架         | 服务器 `/home/sysmex/ai-shifu/docker/ivd-knowledge-tree.html`，`const TREE = {...}`（2026-09-21 生成） | 13 个领域、39 个节点、97 条边、9 门课；`views` 只有 technical / sales / all 三种文字描述                   |
| wiki 课程         | blog 库 `post` 表，slug `course-<bid>`                                                                 | 55 门课（51 已发布、4 草稿）；TREE 的 9 门课 **全部已发布**，0 门未入库                                    |
| wiki 文档         | `data/doc-index.json`（运行时生成，不进仓库）＋ `blog_html_file` 表                                    | 1 篇 HTML 文档《入社培训 · 新人第一周》，9 个 section（p00–p08），分类“新人入学”，关键词“请假，考勤，报到” |
| SharePoint KB MCP | `100.117.252.66:8000/mcp`，SharePoint MCP v1.30.0，systemd `sharepoint-mcp`                            | 见第 5 节实测能力表；delegated 只绑 ZLSW 单站点；全局搜索以 ling.yun 身份跑，结果按该账号权限裁剪          |

### 1.1 一个必须先说的偏差：`data/` 放不下

设计文档原定 TREE 放仓库 `data/ivd-tree.json`，但 `data/` 在 `.gitignore`
里（那是 SQLite 库目录，`/data/` 整目录忽略），提交不进去。
所以骨架与图谱改放在 **`src/content/graph/`**（随代码提交、随构建打包）：

- `src/content/graph/ivd-tree.json` — TREE 原样抽取（唯一事实来源，不手工改）
- `src/content/graph/schema.json` — 本体 schema（类／属性／规则，见第 2 节）
- `src/content/graph/graph.json` — 生成的图谱（`build_wiki_graph.py` 产物）

## 2. Ontology schema（沿用入社培训本体写法）

模式与 `~/workspace/goals/wecom-knowledge-base-pilot-newcomer-first-week/ontology/schema.json`
一致：顶层类＋对象属性（domain/range）＋数据属性＋R 风格规则。
规则编号用 **G1–G9**，与入社培训的 R1–R10 区分。

### 2.1 类（7 个）

| id                 | label         | 说明                                                                                                     | 首批实例来源                                         |
| ------------------ | ------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `Domain`           | 领域          | TREE 的 13 个领域                                                                                        | TREE `domains`                                       |
| `KnowledgeNode`    | 知识节点      | TREE 的 39 个节点（原样保留难度、学时、仪器、参数、关键主题）                                            | TREE `domains[].nodes`                               |
| `Course`           | 课程          | 节点下的课，`shifu_bid` 对 wiki `post`                                                                   | TREE `courses`（9 门）                               |
| `DocSection`       | 文档章节      | `doc-index.json` 里的 section                                                                            | doc-index 导出（9 条）                               |
| `RoleView`         | 角色视图      | 同一张图的三种剪裁，不复制节点                                                                           | 派生（见第 3 节）                                    |
| `LearningPath`     | 带教路径      | TREE `learning_paths`（第二批阶段轴用；首批只记节点归属）                                                | TREE `learning_paths`                                |
| `SharePointSource` | SharePoint 源 | 抽取计划的锚点：站点与文档库；首批只含 ZLSW 站点＋Documents 库两个已验证实例，全文抽取状态一律记“未抽取” | MCP `get_site_info` / `list_document_libraries` 实测 |

### 2.2 对象属性（13 个）

| id                   | domain → range                          | label              | 说明                                                                         |
| -------------------- | --------------------------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `domainHasNode`      | Domain → KnowledgeNode                  | 领域包含节点       | TREE 领域—节点                                                               |
| `nodeHasCourse`      | KnowledgeNode → Course                  | 节点挂课程         | TREE 节点—课程                                                               |
| `nodeHasDoc`         | KnowledgeNode → DocSection              | 节点挂文档         | 关键词／分类匹配（见 4.2）                                                   |
| `domainHasDoc`       | Domain → DocSection                     | 领域挂文档         | 文档只匹配到领域级时用（如入社培训 9 篇挂通识基础）                          |
| `nodePrerequisite`   | KnowledgeNode → KnowledgeNode           | 先修               | TREE 边 `prerequisites`（46 条）                                             |
| `nodeExtends`        | KnowledgeNode → KnowledgeNode           | 进阶               | TREE 边 `extends`（20 条）                                                   |
| `nodeParallel`       | KnowledgeNode → KnowledgeNode           | 并行               | TREE 边 `parallel`（31 条）＋`cross_domain_relations`（4 条，type=parallel） |
| `roleIncludesDomain` | RoleView → Domain                       | 角色看领域         | 派生（第 3 节）                                                              |
| `roleIncludesNode`   | RoleView → KnowledgeNode                | 角色看节点         | 派生（第 3 节）                                                              |
| `pathIncludesNode`   | LearningPath → KnowledgeNode            | 路径含节点         | TREE `learning_paths`（阶段信息记在边数据里）                                |
| `courseMappedTo`     | Course → （post slug，数据属性 `slug`） | 课程对到 wiki 文章 | `shifu_bid` → `course-<bid>`                                                 |
| `siteHasLibrary`     | SharePointSource → SharePointSource     | 站点含文档库       | ZLSW → Documents                                                             |
| `spCandidateFor`     | SharePointSource → KnowledgeNode        | 抽取候选           | 抽取计划第 2 阶段产物；首批无实例                                            |

### 2.3 数据属性（按类）

- **Domain**：`title`、`color`、`description`
- **KnowledgeNode**：`title`、`difficulty`（1–3）、`estimatedHours`、`keyTopics`、`instruments`、`parameters`、`clinicalApps`、`regulations`、`salesKpi`、`sourcePpt`、`audience`
- **Course**：`title`、`shifuBid`、`slug`、`status`（已发布／草稿／未入库／未知）、`lessonCount`、`keywords`
- **DocSection**：`title`、`docKey`、`sectionId`、`docTitle`、`category`、`keywords`、`url`（`/html/<key>#<sectionId>`）
- **RoleView**：`role`（销售／应用／客服）、`note`
- **LearningPath**：`title`、`estimatedTotalHours`
- `SharePointSource`：`siteUrl`、`driveId`、`extractionStatus`（未抽取／元数据已抽／全文已抽）、`itemCount`、`lastSeen`
- **全图**：`generatedAt`、`treeVersion`、`treeSource`（TREE 文件名＋抽取时间）

### 2.4 规则（G1–G9；违反即校验不过，除非注明 WARN）

| id  | 规则                                                                                       | 违反处理                        |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------- |
| G1  | 每个节点必须属于恰好一个领域；领域不存在即不过                                             | FAIL，列出孤儿节点              |
| G2  | 每个课程 `shifu_bid` 必须映射到一个 wiki post slug，或明确标 `status=未入库`；不许静默丢掉 | FAIL；本次 9/9 已发布，0 未入库 |
| G3  | 每条边的两端节点必须存在；悬空边即不过                                                     | FAIL                            |
| G4  | 角色视图只引用已存在的领域／节点                                                           | FAIL                            |
| G5  | 文档 section 必须挂到领域或节点；匹配不上标“未匹配”进清单，不删除                          | WARN＋未匹配清单                |
| G6  | 同一 `shifu_bid` 全图只出现一次                                                            | FAIL                            |
| G7  | 节点 id 全局唯一                                                                           | FAIL                            |
| G8  | 图谱必须带 `generatedAt` 与 `treeVersion`（ provenance）                                   | 缺失为 WARN                     |
| G9  | SharePoint 候选只记实测到的元数据；未抽取全文的不得标“全文已抽”                            | FAIL                            |

## 3. 角色剪裁（首批三档，定义精确到节点集合）

助手侧已定销售／应用／客服三档，图谱页用同一三档（不用图谱页原销售／技术／检验）。
剪裁只过滤显示，不复制节点。

| 角色 | 节点集合（定义）                                                                               | 规模    | 依据                                                                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 销售 | 4 个商务域的全部节点：市场格局、销售策略、产品定位与卖点、商务能力                             | 13 节点 | 恰好等于 `metadata.view == 'sales'` 的 13 个节点（已逐一核对）                                                                                  |
| 应用 | 9 个检验技术域的全部节点：通识基础、血液、尿液、凝血、免疫、生化、分子、分子POCT、国产临床流式 | 26 节点 | 恰好等于 `metadata.view` 为空的 26 个技术节点                                                                                                   |
| 客服 | `learning_paths.service_engineer` 路径的节点                                                   | 8 节点  | TREE 里没有独立的客服视图，这是最接近的服务角色路径（通识＋各领域基础＋质控）；页面上标注“客服（服务工程师路径）”，并注明 TREE 暂无专属客服节点 |

未选角色时默认显示全部（13 域、39 节点）。角色切换只改过滤条件，不改图数据。

## 4. 数据拼法

### 4.1 生成管线（只用 Python 标准库，不联网、不连 MCP）

```
静态页 ivd-knowledge-tree.html
→ scripts/extract_ivd_tree.py → src/content/graph/ivd-tree.json（TREE 原样）
→ scripts/build_wiki_graph.py（+ 下面两份导出输入）
→ src/content/graph/graph.json
→ scripts/validate_wiki_graph.py（G1–G9，退出码 0 通过、1 有 FAIL）
```

两份导出输入（构建时由服务器侧导出，不进仓库、不用手工编）：

- `posts.json`：`post` 表 `slug LIKE 'course-%'` 的 `slug/title/status`（本次 55 行；导出命令见 `scripts/export_wiki_graph_inputs.py` 的说明）。
- `doc-index.json`：容器内 `/app/data/doc-index.json` 的副本（本次 9 个 section）。

构建时没有输入文件也能跑：课程 `status` 记“未知”、文档挂接记“未匹配”，
validate 报 WARN，不静默当成已发布或已匹配。

### 4.2 文档挂接规则（关键词／分类匹配）

1. 文档 `category` 是“新人入学”类入职文档 → 挂 `Domain=general`（通识基础），
   不硬挂到某个具体知识节点（入职文档讲的是报到流程，不是六大检验系统本身）。
2. 其他文档：`keywords` 与节点 `name/keyTopics` 做词面交集，命中 ≥1 个词
   挂到该节点；多个节点命中时全挂（多归属），并在边上记 `matchReason`。
3. 一条都命中不上 → 进“未匹配”清单（G5），不删除、不猜。

### 4.3 运行时叠加（活数据）

页面静态读 `graph.json`（骨架），再调 `GET /api/graph` 拿实时状态覆盖：

- 课程 `status`：`post` 表实时 `slug/status`（已发布／草稿／未入库）。
- 文档：`loadDocIndex()` 实时 section 清单（有更新时页面上显示“有更新”）。
- API 失败时页面降级用构建时的状态，并显示“数据截至 <generatedAt>”。

### 4.4 维护流程

1. TREE 静态页更新后，在服务器上重跑抽取脚本（`scripts/extract_ivd_tree.py`），
   不手工改 `ivd-tree.json`。
2. 重新导出 `posts.json` 与 `doc-index.json`，跑
   `build_wiki_graph.py && validate_wiki_graph.py`。
3. 校验不过先修数据（G2 未入库、G5 未匹配如实标），不要改规则凑数；
   只有领域模式变了才改 `schema.json`。
4. TREE 重生成由谁、何时做——**待用户定**（见第 7 节）。

## 5. SharePoint 抽取计划（2026-11-19 实测能力，不假设）

### 5.1 MCP 实测能力表

服务：`100.117.252.66:8000/mcp`，SharePoint MCP v1.30.0，systemd `sharepoint-mcp`，
Streamable HTTP。`initialize` 后 `tools/list` 须带 `mcp-session-id`，否则 400。
本次实测 20 个工具，结论如下（2026-11-19 06:2x UTC，重启服务恢复认证后实测）：

| 工具                                 | 实测结论                                                                                                                                                                                                             | 抽取用途                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `get_site_info`                      | ✅ 通。绑定的站是 ZLSW（战略参考资料），`https://sysmexcn.sharepoint.com/sites/ZLSW`                                                                                                                                 | 站点锚点                    |
| `list_document_libraries`            | ✅ 通。只有一个库 `Documents`（Shared Documents）                                                                                                                                                                    | 库锚点                      |
| `list_folder_contents`               | ✅ 通。根目录 2 个文件夹（Email attachments、战略部文档）；可递归枚举，返回 id／大小／修改时间／web_url                                                                                                              | 元数据清查（第 1 阶段）     |
| `get_item_metadata`                  | ✅ 通。返回 id、大小、创建／修改时间、mime、web_url                                                                                                                                                                  | 单文件元数据                |
| `get_document_content`（按 item_id） | ✅ 通。docx 全文：段落 9 段＋表格＋属性（作者／创建／修改时间），实测文件 28KB                                                                                                                                       | 全文抽取（第 3 阶段）       |
| `get_document_by_path`               | ❌ Graph 404（路径语义不明）；改走 item_id 可靠                                                                                                                                                                      | 不用，改走 item_id          |
| `search_sharepoint`                  | ❌ Graph 400 `Resource not found for the segment 'search'`（服务端点写错）                                                                                                                                           | 不用，改走 global_search    |
| `global_search`                      | ✅ 通。全租户搜索，`site_url` 可限定单站；回名称／大小／URL，**修改时间一律“未知”**，`top` 参数被忽略、固定回 25 条，但总数会给（如“请假”163 条、“检验 site:ZLSW”4548 条）；以 ling.yun 身份跑，结果按该账号权限裁剪 | 跨站发现候选（第 2 阶段）   |
| `download_file`                      | 未测（base64 下二进制文件）                                                                                                                                                                                          | 大文件／PDF 兜底时再测      |
| `get_lists` / `get_list_items`       | 未测（读列表栏位，不是文档正文）                                                                                                                                                                                     | 带教计划类列表如需抽再测    |
| 写工具（upload／create／update）     | 不用                                                                                                                                                                                                                 | 抽取只读，不写回 SharePoint |

**两个已踩的坑（记下来别重犯）：**

1. 进程内 token 会过期，表现为全部工具报 `SharePoint authentication failed`
   （CLIENT_ID／SECRET／TENANT_ID／SITE_URL）；重启 `systemctl restart sharepoint-mcp`
   即恢复（2026-11-19 已验证）。抽取脚本每次跑之前先调 `get_site_info` 探活，
   失败先重启服务再跑，不要把认证失败当成“没有文件”。
2. `search_sharepoint` 与 `get_document_by_path` 是坏的，不要在抽取计划里用。

### 5.2 站点范围与每站能抽到的粒度

| 站点                              | 用途                       | 元数据                              | 全文                                     | 说明                                                        |
| --------------------------------- | -------------------------- | ----------------------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| ZLSW（战略参考资料，产品资料）    | 产品资料库，节点挂产品文档 | ✅ 清查＋global_search              | ✅ `get_document_content`（已验证 docx） | MCP 绑定的就是本站，全文直抽                                |
| HR 站（人力资源MOSS共享）         | 休假管理、新人训练营入口   | ✅ global_search（名称／大小／URL） | ❌ 目前不行                              | 只能拿到元数据；全文要另起一个绑 HR 站的 MCP 实例（见 5.5） |
| internal-rules（公司制度）        | 正式制度原文               | ✅ global_search（名称／大小／URL） | ❌ 目前不行                              | 同上                                                        |
| 其他站（HEC／acc／ICT／admin 等） | global_search 顺带命中     | ✅ 仅 global_search 元数据          | ❌                                       | 不在抽取范围，先记清单不抽                                  |

规模提醒：ZLSW Documents 共约 177GB（战略部文档单文件夹 17GB，之前报过 5018 条），
**全站全量全文抽取不是一次能跑完的活**，必须按下面四阶段走。

### 5.3 四阶段抽取（只读，不写回 SharePoint）

**第 1 阶段 — 元数据清查（先做，最便宜）：**
递归 `list_folder_contents` 枚举 ZLSW Documents 全树，产出清查清单
（`item_id / path / name / size / last_modified / mime / web_url`），
以 `item_id` 去重。PDF／PPTX／XLSX 先只记元数据，不读全文。
清查清单本身就是交付物：多大、多少文件、分布在哪，先看清再决定抽哪些。

**第 2 阶段 — 按领域关键词发现候选：**
对 TREE 的 39 个节点，用 `key_topics`＋课程关键词组 global_search
（`site_url` 限定 ZLSW；HR／internal-rules 同理只拿元数据），
候选记 `matchReason`（命中词＋来源站）。候选只记元数据，不读全文。

**第 3 阶段 — 选择性全文抽取：**
只对第 2 阶段候选读全文（`get_document_content` 按 item_id）：
先抽 docx（已验证），再测 pdf／pptx 的解析效果（未验证，先试点再批量）；
单文件设上限（先定 5MB，超了记“过大待人工”）；zip／二进制直接跳过记原因。
抽到的全文先落盘为抽取快照（JSON），不直接进图谱。

**第 4 阶段 — 挂接到本体：**
快照按 4.2 的匹配规则挂到节点／领域（`spCandidateFor` 边），
挂不上进“未匹配”清单；每条边记 `matchReason`＋`extractedAt`。
图谱里 SharePoint 文档的 `extractionStatus` 只写实测状态
（元数据已抽／全文已抽），不许把“候选”写成“已抽”（G9）。

### 5.4 增量更新

- 清查清单以 `item_id` 为键；重跑时按 `last_modified` 比对，只重抽变更项；
  删除项先标“下架待确认”，不直接从图谱删（入社培训 R8 的口径）。
- `doc-index.json` 式指纹思路可复用：清查清单整体算一个指纹，变了才触发重抽。
- 增量跑之前先 `get_site_info` 探活（见 5.1 坑 1）。

### 5.5 全站全文抽取是否需要按站点各起 MCP 实例 — 判断：需要

**判断：要。** MCP 服务只绑一个 `SITE_URL`，所有直读工具
（`get_site_info`／`list_*`／`get_document_content`／`get_item_metadata`）
都只认这个站；`global_search` 是唯一跨站工具，且只回元数据、不读正文。
所以：

- ZLSW 全文：现有实例直接抽，不用新起。
- HR 站、internal-rules 站全文：**必须各起一个绑对应 `SITE_URL` 的 MCP 实例**
  （同机不同端口、不同 systemd 服务），否则全文永远拿不到。
- 只做元数据发现时不用新起实例，`global_search` 已覆盖全租户。

**这件事不要擅自做，待用户定**（见第 7 节）：起新实例涉及新端口、新服务、
新的 delegated 授权与可见范围，先定站点范围再动手。

### 5.6 抽取校验规则（SP1–SP6，沿用 R1–R10 风格）

| id  | 规则                                                                                                 | 违反处理            |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------- |
| SP1 | 清查清单必须覆盖枚举到的全部文件；枚举失败的文件夹记“未枚举”，不静默跳过                             | FAIL＋未枚举清单    |
| SP2 | 候选必须记 `matchReason`（命中词＋来源站）；无理由的候选不进图谱                                     | FAIL                |
| SP3 | 全文快照必须记 `extractedAt`＋`item_id`＋`last_modified`；三者缺一即不可信                           | FAIL                |
| SP4 | 抽取只读 SharePoint；任何写回（upload／create／update）都不在抽取计划内                              | 发现即停            |
| SP5 | 权限裁剪如实记：global_search 以 ling.yun 身份跑，看不到的文件不代表不存在，记“权限外”不记“无此文件” | 清单上标注          |
| SP6 | 敏感／涉密文件夹（路径含等）默认不进全文抽取，先由用户逐批放行                                       | 未放行而抽了即 FAIL |

## 6. 首批页面 `/wiki/graph`（领域轴＋角色剪裁）

- 路由 `src/routes/graph.tsx`，登录后可见（与 `/wiki/ai-assistant` 同口径）。
- 左侧角色切换：全部／销售／应用／客服（定义见第 3 节）；领域列表带节点数；
  点领域展开节点；节点卡片显示难度、学时、关键主题、仪器／参数（技术节点）、
  销售 KPI（销售节点）、课程（带已发布／草稿／未入库徽标，已发布的链到
  `/blog/course-<bid>`）、挂接的文档（链到 `/html/<key>#<sectionId>`）。
- 点节点“向助手提问”→ `/ai-assistant?q=请介绍一下「<节点名>」`，
  助手页收到 `q` 参数后自动发一次（复用现有对话模型，不改助手后端）。
- 顶部导航加“图谱”入口（`Header` nav）。
- 阶段轴与人员轴第二批，不在这次做。

## 7. 待用户定的事项

1. **人员轴是否进图谱**（导师看学员状态分支，还是留在状态汇总表里）？
2. **TREE 骨架由谁、在什么时候重新生成**（课上新／下架时）？
3. **角色三档确认**：销售／应用／客服（本次已按这三档实现；图谱页原销售／技术／检验不用）。
4. **抽取站点范围**：ZLSW 全文先抽；HR 站与 internal-rules 站是否起新 MCP 实例做全文（见 5.5），还是先只做元数据？
5. **涉密文件夹放行**：SP6 的类文件夹是否进抽取、以及分批放行的口径？
6. **客服剪裁口径**：本次用服务工程师路径 8 个节点充当客服视图；是否接受，或等 TREE 补专属客服节点？
