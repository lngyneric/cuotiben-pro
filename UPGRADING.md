# Upgrading an existing project

Read this when a project built from this template pulls newer template code.
Entries are newest first. Apply **every entry dated after the template version
the project last pulled**, oldest of those first.

## How to upgrade (every time)

1. **Find the baseline.** The last template commit the project took. Check
   `git log` for a `Template-sync:` trailer. If there isn't one, use the date of
   the last template pull.
2. **Bring the code over.** Merge or cherry-pick the template changes. When a
   file conflicts, keep the project's own changes, but re-apply the template's
   fixes inside it. Never keep the project's old copy of one service while
   taking the template's new copy of a service that depends on it, or the build
   breaks. Pairs that must move together are listed in each entry.
3. **Port the schema by hand.** `src/config/db/schema.ts` is the project's
   gitignored working copy, so pulling does not update it. Diff the template's
   `schema.<dialect>.ts` against the previous version and copy the new
   columns and tables into `schema.ts`.
4. **Apply the schema.**
   - Dev: `pnpm db:push`.
   - Production: `pnpm db:generate`, review the SQL, then `pnpm db:migrate`.
   - Cloudflare D1: re-run `/deploy-cloudflare`. Its Phase 4 generates and
     applies migrations.
5. **Register new permissions.** Run `pnpm admin:token sync-permissions`. It
   adds missing `admin.*` permission rows and never changes role assignments.
   Re-running `/deploy-cloudflare` does **not** do this, because it skips RBAC
   once roles exist. For remote D1, run the command against the local D1 copy
   and apply the `INSERT OR IGNORE` dump, the same way Phase 4.5 of that skill
   does. `super_admin` holds `*` and works without this step. You only need the
   new rows to grant new permissions to other roles.
6. **Install and verify.** Run `pnpm install`, `pnpm build`, and the
   `pnpm test:*` scripts. On Workers, also run `pnpm cf:build`.
7. **Record the sync.** End the upgrade commit with
   `Template-sync: <template sha>`.
8. **Hand over what code can't do.** Some items need the project owner:
   deployment env vars, running migrations on production, re-entering
   secrets. List every such unchecked item to the user when the upgrade is
   done, with the exact value to set (e.g. `PLAUSIBLE_SCRIPT_HOSTS=stats.example.com`,
   taken from the project's own settings), not just a link to this file.

When you change the template itself, add an entry here for anything an
existing project must act on. That covers schema, env vars, renamed or removed
exports, permission codes, and behavior that changes for end users.

---

## 2026-11-26: PPT agent 轻量路——outline 走 Magpie LLM 分组＋Jev 判分组

- 内容：① 上传文本 outline 拆分改走 Magpie LLM（`src/modules/presentations/outline-llm.ts` 新增，模型 `opencode-go/deepseek-v4.1-flash`，复用 AI 学习助手调 Magpie 的配置 `openai_base_url`/`openai_api_key`，60 秒超时、temperature 0.3、只输出 JSON）；LLM 只做分组（标题＋段落编号归属＋版式建议 A–H），要点正文仍由确定性代码从来源原文取、不编内容，source refs 不丢、来源过薄的页仍标 insufficient 不扩写；输入超 12000 字走确定性拆分不截断。② LLM 分组校验：页数 1–50、每页至少 1 个段落编号、每个编号恰好用一次、标题非空，校验失败回退确定性拆分。参考 PPT（一页原稿一页成稿）与知识库（一篇文章一页）保持确定性 1:1，不走 LLM。③ Jev 判分组：草稿建好、返回用户确认之前调一次（复用 AI 学习助手 `callJevQuestions`，query 用用户意图/原始提示、candidates 用各页标题＋要点；再加一层页内一致性——同一次调用里每页多问一题要点是否都围绕页标题同一主题；每 8 页分一次调用；阈值沿用 `JEV_RELEVANCE_THRESHOLD` 0.6，任一分低于 0.6 即该页不通过）。④ 不通过自动重分一次（更细粒度：LLM 重提时加“拆得更细”指令，确定性重分时页上限 800→400 字、要点上限 6→4 条），复判仍不通过 → `needs_review`，草稿带疑点页＋原因返回，由用户在确认时定夺，不后台死循环；结构性页面（无 upload_text 页）无法重分，直接标疑点。⑤ Jev 超时/失败/无 key → `skipped`，记一条日志，按原流程返回草稿，不阻塞。⑥ 判定结论持久化：`presentation_outline` 新增 nullable TEXT 列 `verdict`（migration `drizzle/0005_outline-verdict.sql`，三方言模板＋journal 已更新），存 JSON `{status: pass|needs_review|skipped, splitMode, attempts, scores: [{pageNo, relevance, coherence, failed, reasons[]}], warnings, judgedAt}`；用户确认时改了 pages → verdict 清空。⑦ 生成时 outline 的 verdict 拷进 `generation_meta.outlineVerdict`（migration 0004 已有列，不新增列；结构不对只丢该字段、不判整个 meta 无效）。⑧ 只加法、不改契约：outline 草稿响应新增 `verdict` 附加字段；MCP `presentations_outline` op 输入加可选 `intent`（1–2000 字，Jev query 与 LLM 分组上下文）；`presentations_outline_confirm` 与 `presentations_generate` 的必填项不动。AI 助手 PPT 页签建草稿传 `intent`（无则用 content），草稿面板琥珀色展示服务端返回的警告文案（不新增 i18n key）。⑨ 模型全程仍是 deepseek-v4.1-flash，Presenton 配置未动；不做 wiki 侧写内容。⑩ 测试：新增 `tests/presentations-outline-judge.test.ts`（LLM 分组有效/非法 JSON 回退/超时回退、Jev 全过/一页不通过重分后通过/两次不通过 needs_review/Jev 不可用 skipped/confirm 改页清空 verdict、生成时 verdict 进 generation_meta）；全量见 PR 描述。
- 对已有项目：migration `0005`（`presentation_outline.verdict` nullable TEXT，部署时应用到生产 blog.db；先查 PRAGMA table_info 再 ALTER，幂等）；无新权限码；**行为变更**：outline 草稿现在可能调 Magpie LLM 与 Jev（建草稿耗时从毫秒级变为秒级，最长约 75 秒），两者都不可用时流程与原来完全一致（确定性拆分＋verdict=skipped），不阻塞；草稿响应多一个 `verdict` 字段。
- 注意：① `npx tsc --noEmit` 全仓 52 个既有错误（与基线 2520cbf 相同，零新增）；② 正式端到端生成验收仍待用户建临时 1 天 agent key，单测＋构建＋冒烟不替代它。

## 2026-11-26: PPT agent 导航＋意图优化——页签导航＋单页 outline＋标题页开关＋生成后校验＋意图/习惯

- 内容：① AI 助手页改页签布局：`src/routes/ai-assistant/route.tsx` 由空 `<Outlet />` 改为带页签（对话｜PPT）的布局（nav 数组模式，照 settings/admin），对话页 PPT 入口去掉 `target="_blank"`，PPT 从独立路由变页签面板；聊天记录（localStorage `ai-assistant-chat-v1`）与 PPT 任务轮询（按 jobId 恢复，不重跑）切换时保留。② P0 遗留的前端 outline 步骤做到 PPT 页签里：新增 `POST /api/ai-assistant/presentations/outline`（action=create/confirm，复用 `admin.presentations.generate` 权限，不新增权限码；create 传 content 即登记为 upload_text 来源再划 outline，或直接传 sourceIds；confirm 可传调整后 pages），PPT 页签一键生成 standard 时先在页签内建 outline 草稿（每页标题可编辑、删页重编号、1 页时可合并多页为 1 页）再确认生成。③ 单页也走轻量 outline：standard 一律须带已确认 outlineId（收掉 P0 的 nSlides=1 豁免），页数唯一来源是 outline；smart 免 outline 不变。④ 标题页变可开关意图参数：`titlePage?: boolean`（MCP schema、Web API、服务层三处直通；不传时默认多页保留、单页不保留）；生成指令追加标题页块（保留／不要做封面）；standard 发给 Presenton 的请求体加 `include_title_slide`。⑤ 生成后校验＋重试一次：`presentation_job` 新增 nullable TEXT 列 `generation_meta`（migration `drizzle/0004_ppt-generation-meta.sql`，三方言模板＋journal 已更新），存 expectedSlides/titlePage/retries/resume；完成时（smart stream、standard refreshJob 两路）校验实际页数＝要求页数、首頁版式符合标题页开关，不符按 outline 重试一次（指令收紧：页数以元数据为准、正文其他页数一律忽略），仍不符置失败并说明原因，不静默交错稿。查因结论：Presenton 无最小 3 页写死——3 页那单实际请求就是 nSlides=3（内容也写明“页数填 3”），故不做删页兜底。⑥ 意图层：PPT 页签生成前先 `parsePptIntent` 从一句话里抽页数与标题页开关（页数填 N ＞ 做 N 页 ＞ 共 N 页 ＞ 第 N 页取最大页码 ＞ 一页/单页；“不要做封面”等否定说法优先），抽到的写回表单并展示意图摘要，抽不到按表单值走、不猜；复用已有 outline LLM 拆分，不另接模型服务。⑦ 习惯层：localStorage `ai-assistant-ppt-prefs-v1` 记 {nSlides, titlePage, mode, template}（生成成功时记，下次默认按习惯走，随时可改）；wiki 没有人均偏好位置（config 表是全局管理员配置），故不用服务端存储，习惯本机、不跨设备。⑧ 测试：`tests/presentations.test.ts` 20/20（新增 5 例：标题页开关三态、页数不符重试后失败、不要标题页但首頁 title_intro 时重试后失败、保留标题页且首頁 title_description_image 时完成、generation_meta 解析）；`tests/ai-assistant-presentations.test.ts` 16/16（新增 6 例 outline 路由）；新增 `tests/ai-assistant-ppt-shared.test.ts` 7/7；stage1/2/3 的无 outline standard 用例与 1 页 outline 的 stub 页数（pres-1 默认 2 页）同步修齐；全量 246/247（1 项 admin-agent 既有 ENXIO 环境失败，基线同样失败）。
- 对已有项目：migration `0004`（`presentation_job.generation_meta` nullable TEXT，部署时应用到生产 blog.db；先查 PRAGMA table_info 再 ALTER，幂等）；无新权限码；**行为变更**：单页 standard 生成现在也须先确认 1 页 outline（P0 的 nSlides=1 豁免已收掉），不带 outline 的 standard 生成一律报 `invalid_input`；smart 与单页快讯不受影响。`presentations_generate` 的 MCP 描述同步更新。
- 注意：① `npx tsc --noEmit` 全仓 52 个既有错误（与 P0 基线 40a1a96 相同，零新增）；② 正式端到端生成验收仍待用户建临时 1 天 agent key，单测＋构建＋冒烟不替代它；③ wiki 任务表与 Presenton `presentations` 表口径不一致（Presenton 有 1 单 2 页与 1 单 3 页不在 wiki 已完成列表里），待核对。

## 2026-11-26: PPT agent P0 优化——outline 默认必走＋smart 模板 guard＋标题消毒

- 内容：① outline 默认必走：`validateGenerateInput` 新增校验——standard 模式多页生成（`nSlides>1` 或不传 `nSlides`）必须带已确认的 `outlineId`，否则报 `invalid_input`（指明先调 `presentations_outline` 生成并确认页面划分）；单页 standard（`nSlides=1`）与 smart 模式免 outline；带来源生成原有的强制 outline 逻辑不动。② 模式收敛 guard：显式传 `template` 又传 `mode: 'smart'` 时报 `invalid_input` 拒绝（smart 的 Presenton `/create` 接口不接受 template，不静默转 standard）；`presentations_generate` 的 MCP schema 去掉 `template` 的 `.default('sysmex')`，这样解析后才能区分显式传入还是默认值，服务层 `(input.template || 'sysmex')` 兜底、行为不变；工具描述同步写明 smart 调不了模板且只适合单页快讯、多页须先确认 outline、standard 下模板默认 sysmex。③ 标题与提示分离：新增 `sanitizeDeckTitle`（优先取前 5 个非空行里的 Markdown 标题行，否则取首行，截断到 40 字），`deriveTitle` 与完成时 `completeJob` 的标题写回都走它，Presenton 回的整段提示原文标题不再原样入库；有 outline 时标题仍取 outline 第一页标题。④ 测试：`tests/presentations.test.ts` 新增 P0 两例（多页无 outline 被拒／单页放行／smart+显式 template 被拒／smart 不传 template 放行；标题消毒单测）与 Presenton 请求体 `template: 'sysmex'` 断言；`tests/presentations-stage1/2/3.test.ts` 与 `tests/ai-assistant-presentations.test.ts` 里无 outline 的多页默认调用改为 `nSlides: 1`；`tests/presentations-logo.test.ts` 的默认模板测试改为断言 schema 不补默认值（有效默认值由请求体断言覆盖）。
- 对已有项目：无 migration、无新权限码；**行为变更**：此前不带 outline 的多页 standard 生成（MCP、AI 助手 PPT 页一键生成）现在会报 `invalid_input`，调用方须先走 outline 确认流程；AI 助手 PPT 页（`/wiki/ai-assistant/ppt`）的一键生成默认 `nSlides=6`、不带 outlineId，多页 standard 一键生成部署后会被拒（单页 standard 与 smart 一键生成不受影响），该页加 outline 步骤是后续前端改动、本次未做。
- 注意：① `npx tsc --noEmit` 全仓 52 个既有错误（与基线 3d9e7bf 相同，零新增）；② 正式端到端生成验收仍待用户建临时 1 天 agent key，单测＋构建＋冒烟不替代它。

## 2026-11-25: PPT Logo 改嵌模板——sysmex 模板，不再每次上传

- 内容：① 新模板 `sysmex`（`presenton-templates/sysmex/`，`general` 的克隆）：Logo 以 `decorative: true` 的固定图片元素嵌在每页背景右上角（`PPT_LOGO_SLOT`：x=11.55in, y=0.12in, 1.48×0.52in），共 24 处（12 个背景组件变体＋12 个版式的背景拷贝）；`static/logo.png` 是 `public/logo.png` 转透明底后的版本（白底转透明，Logo 本体深蓝＋绿全不透明，可浮于任何底色上）。② wiki 侧不再上传 Logo：删 `tryResolveLogo()`（`src/modules/presentations/images.ts`）与 `service.ts` 的 Logo 上传块；`presentations_generate` 默认模板由 `general` 改为 `sysmex`（schema 默认值、`PRESENTATION_TEMPLATES` 白名单、`src/lib/ppt-templates.ts` 的 `PPT_DEFAULT_TEMPLATE` 与 AI 助手页面下拉）；`PPT_THEME_VERSION` 由 `2026-11-v1` 升到 `2026-11-v2`，主题指令改写为“Logo 已嵌在 sysmex 模板右上角，不要另外放 Logo”。③ 测试：`tests/presentations-logo.test.ts` 重写为模板内嵌契约（默认模板 sysmex、主题指令措辞、模板文件 24 处 Logo、透明底 PNG 断言）；`tests/presentations.test.ts` 改为断言只上传用户文件。
- 对已有项目：无 migration、无新权限码；**部署时必须先把模板装进 Presenton**（`presenton-templates/deploy.sh`，拷进容器并重启——`/app/templates` 不是 volume，容器重建后须重装），否则默认模板 `sysmex` 在 Presenton 侧不存在、生成会失败。旧 `general` 模板仍在，可在生成时显式传 `template: 'general'` 回退（此时无 Logo）。
- 背景：此前每次生成都把 `logo.png` 当文件上传，Presenton 对它跑文档解析／LiteParse OCR，任务 `495f3eca`（2026-11-25）因此 600 秒超时、成稿从未产出。

## 2026-11-25: 知识库抽取链——“已排查”状态＋草稿进图谱＋草稿仅管理员可见

- 内容：① 新状态 `reviewed`（界面“已排查”）：`PostStatus.REVIEWED`、`admin/posts` 增加 tab／状态下拉／批量按钮与中英文文案；`posts_batch_status` 允许 `reviewed`。② 同步链路改语义：主机 `sync-kb-drafts-load.cjs` 对已存在的 `kb-draft-%` 稿子不再一律跳过——状态为 `reviewed` 时输出 FROZEN（不更新、消费掉 pending 行），其余状态输出 UPDATED（覆盖标题／描述／正文／标签＋更新时间，并附更新留痕行）；`sync_kb_drafts.py` 相应消费 UPDATED／FROZEN 行。上游 kb_extract 本就按 SharePoint `last_modified` 发现源文件变化并重新抽取（pending 行），本次未改 ai-shifu。③ 图谱关联同步（主机 `sync-graph-courses.py`）从只读已发布课改为读 `published/draft/reviewed` 三种状态，草稿课也获得节点关联。④ `/api/graph` 按管理员过滤：非管理员只返回已发布课及其关联（服务端过滤，不只靠页面藏），响应新增 `isAdmin`；图谱页管理员可见草稿／已排查课节点（带状态徽标），其他人仍只看已发布。
- 更新语义（已定）：重新抽取覆盖内容时，已发布稿也会被覆盖（已排查是唯一的冻结手段）；覆盖动作在正文末尾留痕（含更新时间与冻结提示）。管理员在 admin/posts 改过草稿又被源文件更新覆盖时，以抽取内容为准，留痕行是唯一记录。
- 对已有项目：无 migration（`post.status` 是自由字符串列）、无新权限码；部署后下次图谱同步（每小时 :25）与抽取同步（每小时 :40）即按新语义跑；已存在的草稿不受影响，直到其源文件下次变化。
- 补丁（同日）：PR #64 上线后发现 `src/lib/admin-operations.ts` 的入口 zod schema 漏了 `reviewed`——`executeAdmin` 先跑 `operation.schema.parse()`，故 admin/posts 上选“已排查”（tab 列表、`posts_create`/`posts_update` 保存、批量“标为已排查”）均报 `Invalid option`。已在 `postStatus` 与 `posts_batch_status` 的 status enum 里补 `reviewed`；回归测试走 schema 层（`tests/kb-reviewed-status.test.ts`）。

## 2026-11-25: PPT Logo 注入——真实 Sysmex Logo + 容器路径修复

- 内容：① `public/logo.png`：真实 Sysmex Logo（275×110，2026-11-25 用户给的 https://eu.sysmex.com.cn/logo.png，sha256 `07b37baa…`，文件本身未改动）。② `tryResolveLogo()`（`src/modules/presentations/images.ts`）容器路径修复：原来只读 `<cwd>/public`，容器 cwd 是 `/app`，最终镜像只从 builder 拷了 `.output`，`/app/public` 根本不存在，静态资源实际在 `/app/.output/public/`，故容器里永远返回 null；现按顺序试 `public/`（本地开发）与 `.output/public/`（容器运行）两个位置。③ `service.ts` 的 Logo 上传与落位逻辑不变：有光栅文件时随图一起上传、按 `PPT_LOGO_SLOT` 右上角 1.48×0.52 英寸落位（提示词级指令）。④测试：新增 `tests/presentations-logo.test.ts`（4 例：public 路径、.output/public 路径、两处都有优先 public、都没有返回 null）；另更新两处既有测试以反映 Logo 随每次生成上传的新行为（`presentations.test.ts` 断言 files 含 Logo 上传、`ai-assistant-presentations.test.ts` 桩补 mcp-upload 分支）。
- 对已有项目：无 migration、无新权限码；部署后生成即带 Logo；如不想注入，删 `public/logo.png` 即可（`tryResolveLogo` 返回 null）。
- 注意：① `public/logo.svg` 仍是 ShipAny 占位（黑方块＋S），SVG 不被上传通道接受、永不使用。② Logo 是白底图，深色标题区上 Presenton 是否保留白底、是否按指令落位，须在真实成稿上核实；本次只修解析路径，不改版式、不改 Logo 图本身。

## 2026-11-25: PPT 阶段 3——原生图表与 Dashboard（P3）

- 内容：①原生图表（`src/modules/presentations/charts.ts`，纯函数、无 DB）：Presenton 的 generate/create 接口只接受提示词文本、没有结构化图表数据参数（2026-11-25 核查其 v1 API 与公开资料确认），故 wiki 按阶段 0/2 的 zip 级手术路子自己落图：往 pptx 里加 `ppt/charts/chartN.xml`（c:chart）＋内嵌 xlsx 工作簿（`ppt/embeddings/Microsoft_Excel_Worksheet*.xlsx`，Sheet1 为类目×系列二维表）＋ slide 内 graphicFrame 引用；图表类型 bar（柱状簇、gapWidth 150）/ line（折线带标记）/ pie / doughnut（holeSize 50），标题主题蓝 14pt 加粗、图例在下；系列颜色只取主题色板（依次 #2F5597、#005B9F、#27AE60、#ED7D31、#9DC3E6、#003266），饼/环形每片一色；数据引用 `Sheet1!$B$2:$B$5` 式 + strCache/numCache 双写，PowerPoint 双击可改数改类型（python-pptx `chart.replace_data` 实测改数后重读生效、LibreOffice 转 PDF 通过）。②数值标签独立开关 `valueLabels`：show_all / hide_all / total_only / percent_only（默认 show_all；“把数字藏起来”映射 hide_all）；切换只改标签层（dLbls），数据与坐标轴不变——total_only 是逐点富文本标签（柱/折线取每类目合计、饼/环形取总计），percent_only 用 showPercent（柱/折线按类目合计、饼/环形按总计，各自合计 100%）。③新 MCP 操作 `presentations_chart_add`（指定页/槽位插一个原生图表；数据只限三路：直接贴数、csv/xlsx 表、内容源带 page_source_refs——无数据明确拒绝“缺数据”，不编示例数字；未指定类型按数据形态自动选并在草稿注明，指定类型明显不合时先回拟确认清单 `requiresConfirmation` + `suggestedType`，confirm 后按指定执行，不静默换型；饼/环形多系列或负值是硬错）与 `presentations_chart_update`（改已有图表：换数据/换类型/切标签；只改 chart 部件＋换数据时内嵌工作簿，标签切换时 slide XML 不动；类型软冲突同样先拟确认；元素不是图表时回 400 invalid_input）。④生成时落图：`presentations_generate` 加 `charts[]`（每任务最多 5 个，须先确认 outline，图表页在 outline 中标记；Presenton 只出标题与要点文字、图表由 wiki 在完成时按数据落入），落图走与文本页同批的完成钩子（`refreshJob` 标准分支与 `runSmartStream` 两路，落图失败则任务置失败、不报完成）；`presentations_get` 回显 `chartAssignments`。⑤Dashboard 组合页：`kpiCards[]`（标题/数值/单位）与同页图表同源——数值须由同页图表数据聚合（`fromData`: agg sum/value/total + series/category，容差 1e-6 相对）或内容源背书（`pageSourceRefs`，算术比对跳过、归属由服务层校验），否则拒绝；数字卡为深海军蓝 #003266 圆角矩形、白字 26pt 加粗（与 11 月单页底部数据条同款），版式走 A（数据条加四卡）或 G/H 分栏。⑥留痕：`presentation_job` 新增 `chart_assignments`（三方言模板 + migration `drizzle/0003_stage3-charts.sql`，仅一条 nullable `ALTER TABLE`）；版本复用阶段 2 的 `presentation_page_version` 与 `ppt-edits/`，无新表；`presentations_get`/`chart_add`/`chart_update` 的 `pagePreview` 与阶段 2 同口径——改后单页元素清单（含图表元素），不是渲染图。
- 对已有项目：部署时跑 `db:migrate`（0003 只加一列）；无新权限码（新操作复用 `admin.presentations.generate` / `.read`，不跑 `rbac:init`）；限额未变（图表每任务最多 5 个、类目最多 50、系列最多 8、数字卡每页最多 4、表格文件 1.5MB）。
- 注意：①更新 Presenton 原生图表时会按 wiki 主题样式重建该 chart 部件（数据保留）。②`insertKpiCards` 的形状用 `<p:cNvSpPr/>`（阶段 2 `add_element` 用的 `<p:cNvCxnSpPr/>` 会使 python-pptx 读形状时报 InvalidXmlError，已在图表路径修掉，add_element 本身未动）。③自动选型：时间类目优先于占比，但只对单系列生效——多系列季度对比仍选柱状。

## 2026-11-25: PPT 阶段 2——单页编辑（P2）

- 内容：①新 MCP 操作 `presentations_page_get`（取指定页元素清单：element_id、类型、当前文字/属性、所在槽位，口述改稿先经此清单定位）、`presentations_page_edit`（改一页：set_text / set_style / move / resize / replace_image / add_element / delete_element；只重写该页，其余页逐字节保留——zip 级手术，只改目标 slide 的 XML，其余条目的 local 记录原样复制）、`presentations_page_revert`（按版本号回退，另起一版复制目标版本，不删行）。②版本与回退：新表 `presentation_page_version`（三方言模板 + migration `drizzle/0002_stage2.sql`），版本文件存在与库文件同目录的 `ppt-edits/` 下（生产即 `/app/data/ppt-edits`，随命名卷持久化；`public/uploads` 不进卷，不能放）；version 从 1 递增，0 = Presenton 原稿；下载始终取最大 version 的文件；`presentations_get` 回显 `currentVersion`。③确认流程：截图模式（`referenceImageId`）与删除/换图类操作先返回拟改动清单（`requiresConfirmation: true`，不写文件），用户确认（`confirm: true`）后才执行；口述 set_text/set_style/move/resize/add_element 直接执行。④规则：set_text 不动位置/字号/颜色；set_style 颜色只认主题色板或调用方声明的用户明确色值（`explicitColor`），不自创配色；move/resize 目标用 slotId（版式注册表）或明确 rectIn（英寸），越界报错不静默裁剪；replace_image 入参为能力一的 image_id，沿用槽位裁切规则（cover-crop，不拉伸）；无 element_id 的历史旧稿调用编辑时明确回 `legacy_not_supported`（400）“旧稿不支持单页编辑”，不回填、不假装可改。⑤单页预览：服务器容器内没有 LibreOffice / pdftoppm 等渲染工具（2026-11-25 实查容器内 `which soffice libreoffice pdftoppm` 均无），`pagePreview` 返回的是改后单页元素清单（非图片），须在 PowerPoint 中打开下载文件核对——不要把它当成渲染图对外宣称。⑥截图识别：服务端没有视觉模型，参考图的差异由调用方 agent 对照 page_get 清单识别后下发 ops；服务端只校验 reference_image 存在且调用方可见、ops 逐项可执行。
- 对已有项目：部署时跑 `db:migrate`（0002 新建 `presentation_page_version` 表 + 唯一索引；生产部署前须先对卷内库跑迁移，见部署记录）；无新权限码（新操作复用 `admin.presentations.generate` / `.read`，不跑 `rbac:init`）；限额未变。
- 注意：①版本文件目录由 `DATABASE_URL` 的 file: 路径推导（`./data/ppt-edits` 为回落值）；D1 / Postgres 等无本地库文件的部署下版本文件不保证持久化。②并发两次编辑同时抢下一个版本号时，后一次记行失败（唯一索引 `uq_presentation_page_version_job_version`），调用方应重试；文件由 `createPageVersion` 清掉，不留孤儿版本。

## 2026-11-25: PPT 阶段 1——内容源、图片库、超时告警

- 内容：①内容源三路（`src/modules/presentations/sources.ts`）：`presentations_source_add` 登记上传文件（复用 AI 助手附件抽取，txt/md/csv/pdf/docx/xls/xlsx，单文件 8000 字、合计 16000 字，超限明确拒绝不静默截断）、参考 PPT（逐页抽文字＋标题＋主题色，单文件 25MB 上限，超限拒绝并提示转 PDF 当内容源或转图片当版式参考；25MB 是上传上限，与 MCP 单次 2MB 调用限额不同——25MB 文件走页面 multipart 路由 `POST /api/ai-assistant/presentations/sources`，抽取在服务端做，只有抽出的文本进 MCP）、知识库主题检索（只查调用人个人权限内已发布内容，草稿与无权内容不进清单，勾选后才纳入）；`presentations_outline` 按来源出页面划分草稿（每页标题、要点、拟用版式与理由、引用来源；上传优先于知识库，知识库只作补充；片段不足的页标“来源不足”不扩写），`presentations_outline_confirm` 确认后才允许生成；`presentations_generate` 加 `sourceIds`/`outlineId`（带来源生成按 outline 逐页组装、每页留 `page_source_refs`；无来源保持现行但结果标 `sourceMode: unsourced`）。②图片库（`src/modules/presentations/images.ts`）：存储复用 wiki 现有文件存储（R2 或本地 `public/uploads`；blog 配图即 `post.image`、/wiki/html 图即文档内 `<img src>`，均先核实再引用），新表 `presentation_image` 只存元数据；`presentations_image_upload`（上传/粘贴截图，扩展名白名单＋mime 比对＋5MB 上限）、`presentations_image_search`（调用人可见范围内按文件名/标签/来源筛，按最近使用排序）；`presentations_generate` 加 `images[{imageId, pageNo, slotId}]`（单次最多 5 张、截图最多 3 张；按版式槽位 cover-crop、不拉伸；小于槽位分辨率标 `low_res`；取不到字节的槽位留空，任务结果列明“第 N 页缺图”，不拿别图顶替）；Logo 仍未注入——仓库与两份设计稿里均无可用的光栅 Logo 文件（只有 `public/logo.svg`），`tryResolveLogo()` 只认 `public/logo.{png,jpg,jpeg,webp}`，缺失时如实记“无光栅 Logo”，不编造、不代放占位图。③超时告警：受理超 10 分钟未完成即置失败 `generation_timeout`，落结构化日志（`job_id`、`elapsed_ms`、`prompt_chars`、`model`、`stage`，轮询发现记 `polling`、smart 流中断记 `smart-stream`）并走 wiki Notify 提醒管理员（与 Magpie 额度告警同路、同一 `notify_llm_quota_enabled` 开关）；每小时跟踪器扫 `presentation_job.error_code` 即可上报，无需改跟踪器。④留痕落库：新表 `presentation_source` / `presentation_outline` / `presentation_image` ＋ `presentation_job` 新增 `image_assignments` / `prompt_chars`（三方言模板 + migration `drizzle/0001_stage1.sql`）。
- 对已有项目：部署时跑 `db:migrate`（0001 新建三张表＋两列 `ALTER TABLE`）；无新权限码（新操作复用 `admin.presentations.generate` / `.read`，不跑 `rbac:init`）；限额未变（50 页/100MB/2MB/1.5MB、8000/16000 字、5 文件/3 截图）。
- 注意：①不同主题的上传文件在 outline 里各占一页，不并页（`packPages` 换主题时断页；同主题过长仍在主题内断页）。②`presentations_image_search` 是 POST（筛选条件在 body 里），不是 GET。③参考 PPT 抽出的全文同样受单文件 8000 字上限约束，过长的 deck 需先拆分。④超时发现时机是下一次 `presentations_get` 轮询或 smart 流中断，不是受理瞬间即时触发。

## 2026-11-25: PPT 阶段 0 地基——版式注册表、主题单点注入、element_id、留痕字段

- 内容：①版式 A–H 注册表（`src/modules/presentations/layouts.ts`）：槽位定义（类型/英寸坐标/比例坐标）按设计稿（`PPT模板设计稿-版式确认.pptx`，13.33×7.5 英寸）实测抄入，页眉与 Logo 位全版式统一；②主题与 Logo 收口到一处：8 色 + 字体 + Logo 位只在 `layouts.ts`，生成时由 `service.ts` 把 `buildThemeInstructions()` 追加进 Presenton 请求的 `instructions`（标准与 smart 共用），任务行记 `themeVersion`（`2026-11-v1`）；③element_id：Presenton 接口不接受元素 ID，wiki 在下载时把稳定 ID（`el-p<页>-<序号>`）写进每个形状的 `<p:cNvPr name>`，索引缓存到任务行 `element_index`，新接口 `GET /api/ai-assistant/presentations/elements?id=` 逐页列出；盖不上时原样返回原字节；④留痕结构落库：`presentation_job` 新增 `theme_version` / `layout_assignments` / `element_index` / `page_source_refs`（三方言模板 + migration `drizzle/0000_right_gamma_corps.sql`）。
- 对已有项目：部署时跑 `pnpm db:migrate`（本仓库第一份 migration；生产库早于迁移系统存在，0000 只含本次 4 条 `ALTER TABLE`，不含全库建表——全新库仍用 `db:push`）。旧任务的 4 列为空：下载旧稿时会现算 element_id 并写回；`layout_assignments` / `page_source_refs` 仍空，等阶段 1 写入；无 element_id 的旧稿调用阶段 2 编辑时仍按清单回“不支持”。
- 注意：主题注入是提示词级的——Presenton 的 generate/async 与 create 接口都没有主题色/Logo 参数，成稿配色以 Presenton 实际出稿为准；Logo 图片本身尚未注入（等阶段 1 的图片槽位映射）。

## 2026-11-23: RBAC 种子补 `admin.*` 通配码（`rbac:init` 不再删掉管理员判定）

- 根因：`scripts/init-rbac.ts` 的“Clear and reassign permissions”会先删光角色的全部 `role_permission` 再按种子重授，但种子从未列出字面量 `admin.*` 这一行。2026-11-22 一次部署为授新码 `admin.mentoring_dashboard.read` 跑了 `rbac:init`，admin 角色被重授为 25 个种子码，`admin.*` 被删；客户端 `isAdmin` 判定（`hasPermission('admin.*')`，只认字面量 `admin.*` 或 `*`）随即变 false，`/admin` 被重定向到 `/settings`。修法：种子新增 `admin.*` 权限定义，并把它加进 admin 角色的种子清单；同时改了展开逻辑——本身就是已定义权限码的 `admin.*` 按字面量授予、不展开，避免把 `admin.passwords.reset` / `admin.payments.refund`（有意只留 super_admin）也显式授给 admin。
- 对已有项目：此改只影响下次跑 `pnpm rbac:init` 时的种子内容，不改运行中的服务、不改数据库。若你的 admin 角色已在某次 `rbac:init` 后丢了 `admin.*`（表现为 `/admin` 跳 `/settings` 且 `/api/user/permissions` 返回 `isAdmin: false`），先直接给 admin 角色补一行 `admin.*`（`role_permission` 表），再取新种子防复发；也可以直接用新种子重跑一次 `rbac:init`（它会按新种子重授 admin 为 26 个码）。

## 2026-11-22: MCP 的 PPT 下载地址改为完整 URL（大圆不再反问站点地址）

- 根因：`presentations_get` 返回的 `downloadUrl` 是相对路径（`/wiki/api/...`），MCP 客户端（企微大圆）是外部调用方，拿不到站点域名，拼不出可点击链接，只能反问用户“企业大学站点网址是什么”。修法：MCP 端的 `downloadUrl` 改为完整 URL（`VITE_APP_URL` 的 origin ＋ `withAppBase` 路径，内网即 `https://eu.sysmex.com.cn/wiki/api/...`）；skill 与 `presentations_get` 工具描述同步明确“`downloadUrl` 是完整地址、原样贴出、不要问用户要站点地址”。页面接口（`/api/ai-assistant/presentations`）的 `downloadUrl` 仍是相对路径，浏览器内使用不受影响。
- 注意：MCP handler 收到的 request 是 `executeAdmin` 重建的合成请求（origin 为 `http://admin.internal`），所以 origin 只能取 `VITE_APP_URL`，不能从 `request.url` 取。内网部署须保证 `VITE_APP_URL` 是真实公网地址（现为 `https://eu.sysmex.com.cn/wiki`），否则大圆拿到的链接仍不可用。

## 2026-11-22: 独立 PPT 页路由嵌套修复（/ai-assistant/ppt 曾渲染成对话页）

- 根因：`/ai-assistant`（文件路由）与 `/ai-assistant/ppt`（子路由）共用父路由，但父组件（对话页）没有渲染 `<Outlet />`，子路由无处挂载——URL 与标题正确，内容却是对话页。修法：按 TanStack 惯例拆成布局路由 `src/routes/ai-assistant/route.tsx`（只渲染 `<Outlet />`）＋对话页移为 `src/routes/ai-assistant/index.tsx`（`createFileRoute('/ai-assistant/')`）＋`ppt.tsx` 不变。URL 不变（仍是 /ai-assistant/ppt），无 schema、无新权限。
- 教训：点号文件名（`ai-assistant.ppt.tsx`）并不能把子路由变平，仍会挂在父路由下；要独立渲染必须用布局＋Outlet。本地冒烟只看状态码发现不了此类问题，须浏览器实测页面内容。

## 2026-11-22: 独立 PPT 页去掉「返回对话」链接（理解修正）

- 独立 PPT 页（/ai-assistant/ppt）顶部的「返回对话」链接已去掉：它是把“返回大圆对话页面”误解成 wiki 页面内跳转才加的。大圆是企微助手，返回大圆靠 MCP 反馈流程（见上一条），不是 wiki 页内链接。独立页用新标签页打开，关掉标签即回对话页；登录提示卡（大圆卡片）不受影响，仍正常显示。
- 删除 `ai_assistant.ppt_back_to_chat` 文案（中英文）。无代码逻辑变化、无 schema、无新权限。

## 2026-11-22: 大圆（企微助手）PPT 完成反馈流程（skill 明确）

- 企微大圆经 MCP 生成 PPT 时，skill 明确反馈流程：生成开始立即在对话里告知用户正在生成及预计时长；约每 15 秒轮询 `presentations_get` 直到完成或失败（最长 10 分钟）；完成后在对话里回复标题、页数和可点击的下载链接；失败时回复失败原因，不让用户干等；不得在未报告结果前静默切换到其他引擎。
- 只改 `.claude/skills/shipany-admin/SKILL.md`（大圆读的 skill 文本），无代码、无 schema、无新权限。skill 由部署后的服务提供，大圆下次读取即生效；生效后请在大圆里实际生成一次 PPT 验证能收到下载链接。

## 2026-11-22: AI 学习助手 PPT 独立生成页 + 版式选择 + 对话框可拖动

- 助手页「生成 PPT」对话框新增「在单独页面打开」入口：独立页 `/ai-assistant/ppt`（与对话框同一套生产接口），内容默认取最近对话与参考资料，可改；含页数、模式、版式、补充说明四项详细设置，生成状态与「最近生成的 PPT」列表与对话框共用本机 localStorage；页顶有「返回对话」链接回助手页。
- 版式（template）：下拉可选 Presenton 16 个内置版式（通用默认），生成时即定好配色与排版，不用事后再调；服务端只接受白名单内的版式（未知值返回 400）。版式只在标准模式生效，智能模式下 Presenton 的 create 接口不接受 template，选框禁用并注明由系统自动选择。
- 对话框可拖动：按住标题栏移动；内容区可滚动、底部按钮固定可见，小屏上按钮不再出屏。关闭对话框后拖动位置归零。

### Action required

无。

## 2026-11-22: AI 学习助手 PPT 指引 + 已生成任务列表

- 对话助手以前不知道页面有「生成 PPT」按钮，用户问做 PPT 时会直接拒绝（“无法生成或存储 .pptx”）。现在 system prompt 加了一条规则：用户要 PPT 时指引点本页的「生成 PPT」按钮（内容默认取最近对话，可改；页数 1–50），并可先帮用户把要点整理成大纲。
- 助手页新增「最近生成的 PPT」列表：已完成的任务记到本机 localStorage（`ai-assistant-ppt-jobs-v1`，最多 5 条），刷新页面后下载链接还在；进行中的任务不在列表里。

### Action required

无。

## 2026-11-21: PPT 下载链接补 /wiki 前缀（修 404）

- PPT 任务完成后的 `downloadUrl` 以前是裸 `/api/admin/agent/presentations/download?id=...`。页面把它当普通 `<a href>` 渲染，点开后浏览器走到裸域名，nginx 把 `/api/*` 交给 ai-shifu（Flask），返回 `{"code":404,"message":"The requested URL was not found on the server..."}`。现在服务端用 `withAppBase()` 生成下载地址，内网部署下是 `/wiki/api/...`，Cloudflare 部署（无 base）保持原样。
- 同一处修复也覆盖 MCP 的 `presentations_get` 返回的 `downloadUrl`。

### Action required

- 无 schema 变化、无新权限码、无新环境变量、无新依赖。已部署的版本直接随下次重建生效。

## 2026-11-20: AI 学习助手页生成 PPT（接生产 Presenton 接口）

- `/wiki/ai-assistant` 有 `admin.presentations.generate` 权限的用户会看到“生成 PPT”按钮：点开对话框，内容默认填最近一轮提问 + 最新助手回答 + 参考资料文本（可改），页数默认 6（1–50）、模式标准/智能、补充说明可选；提交后每 5 秒轮询任务状态，完成后显示标题、页数与下载链接，失败显示服务端返回的错误。
- 新路由 `POST/GET /api/ai-assistant/presentations`：与 MCP 的 `presentations_generate` / `presentations_get` 是同一套服务（`src/modules/presentations/service.ts`），调用方是登录用户（session；`authenticateAdmin` 也接受 agent key），归属按 `(userId, tokenId)` 配对，非属主查任务一律 404；下载复用现有的 `/api/admin/agent/presentations/download`。限流：IP 200ms，建任务每人 10 秒。
- `GET /api/user/permissions` 现在除 `isAdmin` 外还返回调用方自己的权限码列表（供页面按权限显隐入口；服务端接口仍各自鉴权）。

### Action required

- 无 schema 变化、无新权限码（复用 `admin.presentations.generate` / `admin.presentations.read`）、无新环境变量、无新依赖。已授过这两个权限的角色（admin、course-advisor）直接可用。

## 2026-11-20: AI 学习助手附件上传与截图粘贴

- `/wiki/ai-assistant` 对话框旁新增附件按钮（支持 txt、md、csv、tsv、docx、pdf、xls、xlsx 与 png、jpg、gif、webp 图片），输入框支持直接粘贴截图；截图在浏览器里缩放（最长边 1568px、JPEG 0.9）后再发。
- 新模块 `src/modules/ai-assistant/attachments.ts`：文字类附件服务端抽取文本拼进参考资料（每文件 8000 字、合计 16000 字），图片以 `image_url` 直通模型；每次最多 5 个文件、其中图片最多 3 张、base64 总量 ≤2MB；doc/odt/rtf/ppt/pptx 明确拒绝并给出中文提示。
- 参考资料文本存在浏览器 localStorage（与对话分开的 key），每轮带回；新上传替换旧的，没有新附件时旧的原样带过。审计事件 `ai_assistant_query` 仍只记元数据，不记附件内容。

### Action required

- 部署时跑 `pnpm install`：新增依赖 `mammoth`、`pdf-parse`（v2）、`xlsx`（均已进 `pnpm-lock.yaml`）。无 schema 变化、无新权限码、无新环境变量。

## 2026-11-20: Wiki agent PPT generation (Presenton)

### Action required

- **Schema:** new table `presentation_job`. Dev: `pnpm db:push`. Production: `pnpm db:generate`, review the SQL, then `pnpm db:migrate`.
- **Permissions:** run `pnpm admin:token sync-permissions` so the new `admin.presentations.generate` / `admin.presentations.read` rows exist, then grant them to the agent role that should generate PPTs (Admin → Roles). `super_admin` holds `*` and works without this step.
- **Settings (manual, by the project owner):** Admin → Settings → AI → PPT（Presenton）: set `presenton_base_url` (default `http://presenton-trial:80`) and paste the Presenton admin API key into `presenton_api_key`. Without the key every generate call fails with `Presenton is not configured`. The key is never stored in the repo.

### What changed

- New module `src/modules/presentations/service.ts`: Presenton client (upload via `/mcp-upload`, standard mode via `/generate/async` + status polling, smart mode via `/create` + SSE stream) plus the `presentation_job` table. Generation is async — the wiki never blocks on it and runs no background worker; status refreshes on `presentations_get`.
- New admin operations `presentations_generate` (`admin.presentations.generate`) and `presentations_get` (`admin.presentations.read`), new download route `GET /api/admin/agent/presentations/download?id=<jobId>`. Jobs are owned by the calling agent account (`userId` + `tokenId`); other callers get 404 on read/download, and Presenton edit URLs are never returned (the shared Presenton admin sees every deck).
- Magpie quota/rate-limit failures surface as a distinct `llm_quota_exceeded` error (job `errorCode`, HTTP 429) and trigger a notify alert (`notify_llm_quota_enabled`, default on) instead of a generic 500.
- Limits: at most 50 slides per deck; files at most ~1.5 MB base64 per MCP call (Presenton upload cap is 100 MB); image generation is disabled (placeholder images).

---

## 2026-11-20: Growth Path page — personal-growth tree moved into the wiki

### Action required

- None for the wiki itself (new page, static data, no schema change).
- Retire the old standalone page: redirect `/personal-growth-tree.html`
  to `/wiki/growth` in the ai-shifu nginx config (the old page must no
  longer be served as a destination; see `docs/wiki-growth-path.md`).

### What changed

- New page `/growth` (“成长路径”, `src/routes/growth.tsx`): the personal
  capability tree from `personal-growth-tree.html` rebuilt in the ShipAny
  design language — theme tokens, shadcn components, no hardcoded dark
  theme, no emoji in headers, `growth.*` i18n keys in both locales.
- Data is static content `src/content/growth/growth.json` (35 nodes,
  9 domains, 8 courses, 27 gaps), ported from the old page's embedded
  TREE (v1.0.1). Node fields kept: difficulty, estimated hours, phase,
  skills, prerequisites / extends / parallel, courses (shifu_bid + title).
- The page reuses the wiki graph's no-D3 `VisualGraph`
  (`src/routes/graph/-visual-graph.tsx`) for the force-directed view,
  with list/visual toggle persisted as `growth-view-mode`.
- Course links point at the ai-shifu player (`/c/<shifu_bid>`), not at
  blog posts: these 8 courses exist in ai-shifu but were never synced
  into the blog's `course-<bid>` posts, so there is no blog slug to link
  to. (Do not “fix” this by pointing at `/blog/course-<bid>` — it 404s.)
- A “学习计划” section lists the visible nodes in prerequisite
  (topological) order with total hours, so the page answers “where do
  I start” without the old page's AI-generated plan.
- Naming/positioning (why this is a separate page, not a tab of the
  knowledge graph): `/graph` is the company knowledge map (“what
  exists”), `/growth` is the personal path (“where am I, what next”).
  The old page and the TREE page both called themselves “知识图谱”,
  which is the confusion this change removes. See
  `docs/wiki-growth-path.md` for the full three-graph design.

---

## 2026-11-20: Draft preview eye + graph course links — respect the app base path

### Action required

- None (code fix only, no schema or config change).

### What changed

- The admin posts “preview” (eye) button opened `/blog/<slug>` with a raw
  `window.open`, which drops the `/wiki` base path and 404s. It now goes
  through `withAppBase`, so the preview opens at `/wiki/blog/<slug>` and
  the admin draft preview works again.
- Same fix for the graph visual view: clicking a course node opened
  `/blog/<slug>` raw and 404d; it now also uses `withAppBase`.
- Rule of thumb: any `window.open` / plain `<a href>` that builds an
  absolute path must go through `withAppBase`; TanStack `<Link>` already
  prepends the base path, which is why the blog list cards were fine.

---

## 2026-11-19: Graph doc links — fix broken HTML document URLs

### Action required

- None (data + code fix only, no schema or config change).

### What changed

- Graph page “related docs” links (e.g. 通识基础 → 入社培训 · 新人第一周)
  pointed at `/html/html/<key>#<section>`, which 404s: the doc key itself
  starts with `html/`, and `/html/<key>` is not a viewer route. Links now
  follow the same rule as `blogHtmlUrl`: `/api/blog/html/<url-encoded key>`
  - `#<sectionId>`, with the app base path (`/wiki`) prepended by
    `withAppBase`. The page builds the URL from `docKey` + `sectionId` at
    render time instead of trusting the static `url` in `graph.json`.
- Fixed the 9 `DocSection` `url` values in `src/content/graph/graph.json`
  and the root cause in `scripts/export_wiki_graph_inputs.py` (it prepended
  `/html/` to a key that already starts with `html/`), plus the DocSection
  `url` description in `docs/wiki-graph-ontology.md`.

## 2026-11-19: Knowledge graph — visual view, stage axis, people axis, live course links

### Action required

- **New tables** `role_person_map` and `graph_course_link` (three dialect
  templates + `schema.ts`). Production: create them directly in the blog
  database (script `~/workspace/tools/create-graph-tables.cjs`), or
  `db:generate` + `db:migrate`.
- **Host crons** (server `/home/sysmex/graph-sync/`, hourly):
  `sync-graph-courses.py` at :35 (keyword-links published blog courses to
  graph nodes → `graph_course_link`) and `sync-role-person-map.py` at :45
  (WeCom role-person map → `role_person_map`). Both have `--dry-run` and a
  Node loader that full-replaces the table in a transaction.

### New, no action needed

- Graph page (`/wiki/graph`) gains three axes: 领域 (list / visual-graph
  toggle, persisted as `graph-view-mode`), 带教阶段 (sales/technical/lab ×
  4 stages from `ivd-tree.json learning_paths_detail`, node → domain detail),
  人员 (admin sees all mentors, a mentor sees only their own mentees;
  mapping is verified against `role_person_map`, flags from
  `user_status_summary`, rule-based course recommendation — no LLM).
- New API `GET /api/graph/people` (session auth; admin or mentor only, else
  403). `GET /api/graph` now also returns `links` (dynamic course links)
  and `counts` (published/linked course totals); the page's course count is
  live instead of the static 9 from TREE.
- Visual graph is a dependency-free SVG force layout
  (`src/routes/graph/-visual-graph.tsx`): drag nodes, wheel zoom, drag
  background to pan, click a node for its detail, click a course to open it.
- Fixed: clicking a course button at the bottom of the page no longer leaves
  the viewport at the bottom — the detail section scrolls into view.

### Known limits

- Stage view skips nodes that are in `learning_paths_detail` but not in
  `graph.json` (currently 1: `hematology-quality`); the skipped count is
  shown at the bottom of the stage view.
- The people recommendation is a fixed rule (pending_confirm → no course;
  no_course_activity → first published course of stage 1; otherwise the
  first untaken published course in path order). It does not read the
  mentor's free-text comments.

## 2026-11-19: Notepad drops subject categories, adds CSV import

### Action required

None. Pure frontend change; no schema, permission, or env change.

### New, no action needed

- Knowledge graph page (`/wiki/graph`, role filter sales/application/service,
  node → assistant via `/ai-assistant?q=`), live overlay API (`GET /api/graph`),
  and ontology sources in `src/content/graph/` (`ivd-tree.json`, `schema.json`,
  `graph.json`; built by `scripts/extract_ivd_tree.py` +
  `scripts/build_wiki_graph.py`, checked by `scripts/validate_wiki_graph.py`).
  See `docs/wiki-graph-ontology.md` (includes the SharePoint extraction plan).

- `/cuotiben` (记事本) is now for the corporate university, so the
  school-subject categories are gone from the UI: no more subject filter
  chips on the page (only the all / pending / done status filter
  remains), no subject in search, no subject chip on cards, and no
  subject dropdown in the add form. The `cuotiben.form_subject` message
  key is left in `messages/{en,zh}.json` (unused, harmless). The backend
  `subject` column and the API are untouched; new cards are created with
  `subject: ''`.
- The "来源" (source) field in the add form changed from a fixed
  dropdown （中文数学 / igmath / igscience) to a free-text input
  (e.g. a course name). New i18n key: `cuotiben.form_src_placeholder`.
- Manual import now accepts `.csv` files as well as `.json`
  (file picker `accept=".json,.csv"`). A CSV's first row is the header;
  Chinese and English headers are both recognised (内容/question,
  答案/answer, 我的答案/myAnswer, 原理/原理/公式/principle,
  笔记/note, 标签/tag, 来源/src, 已完成/mastered). Quoted fields,
  embedded commas/newlines and `""` escapes are handled. Rows missing
  content or answer are skipped; the subject column, if present, is
  ignored. Picking a `.csv` file parses and imports it directly; picking
  a `.json` file still loads it into the textarea for the existing flow.
  New i18n keys: `cuotiben.btn_import`, `cuotiben.import_format_hint`,
  `cuotiben.invalid_csv`.
- The import endpoint now respects `mastered: true` from the payload
  (previously it hardcoded `mastered: false`), so the CSV 已完成 column
  works (true / 1 / 是 → 已完成).

---

## 2026-11-19: Wiki operations timeline on the notepad page

### Action required

None. Pure frontend change plus a read-only aggregation endpoint; no
schema, permission, or env change.

### New, no action needed

- `/cuotiben` (记事本) now has a "Wiki 操作" section below the card
  timeline. It shows a to-do panel plus a unified event list (newest
  first, at most the 100 most recent), fetched from the new endpoint
  `GET /api/cuotiben/timeline` (login required; IP 200ms + per-user 2s
  rate limit, same as the AI assistant routes).
- Event sources (all filtered to the current user): AI assistant
  questions (`user_event` ai_assistant_query — only mode/found/course
  count, never the question text), note cards (`cuotiben_card`),
  admin batch article-status changes (`admin_execution`
  posts_batch_status, completed only), HTML uploads
  (`blog_html_file`, links straight to the file), mentor
  confirmations/comments (`user_status_summary.actual.confirmations`),
  and the latest system sync (`user_status_summary` max `computed_at`).
  `posts_batch_status` is grouped under the admin category, not a
  separate article category.
- To-dos count mentoring records whose flags contain
  `pending_confirm` / `overdue` / `unresolved_identity` /
  `no_course_activity`. Admins see all records; other users see only
  their own (by employee number). The panel is a persistent reminder
  with a hide/show text button; the choice is stored in the browser's
  localStorage (`cuotiben-todos-visible`, '1'/'0', default '1'). When
  hidden, only one line ("待办事项（已隐藏）") plus a Show button
  remains. Category filter chips filter the event list only; there is
  no per-category toggle.
- New i18n keys: `cuotiben.ops_title`, `cuotiben.ops_empty`,
  `cuotiben.ops_open`, `cuotiben.ops_cat_assistant`,
  `cuotiben.ops_cat_admin`, `cuotiben.ops_cat_mentor`,
  `cuotiben.ops_cat_system`, `cuotiben.ops_cat_html`,
  `cuotiben.ops_cat_card`, `cuotiben.todo_title`,
  `cuotiben.todo_pending_confirm`, `cuotiben.todo_overdue`,
  `cuotiben.todo_unresolved`, `cuotiben.todo_no_course`,
  `cuotiben.todo_hide`, `cuotiben.todo_show`,
  `cuotiben.todo_hidden` (zh + en). Event titles themselves are
  data-driven Chinese strings built server-side (they embed names,
  counts and node names), so they stay Chinese even in the English
  UI; only the surrounding chrome is localized.
- Known limits (as observed in production, not bugs): mentor
  confirmations are currently empty — the only structured row
  (官雨润) has passed/confirmedAt/comments all null, so no mentor
  events appear until a mentor actually fills one in; the system-sync
  event shows only the latest sync (there is no sync history to list);
  cards have no "completed at" column, so card events use the
  creation time and show the current status (已完成/待处理) as the
  detail; to-do counts are per mentoring record, so a person with two
  records (e.g. 谢艳芳) counts twice.

---

## 2026-11-19: Notepad restyled to the ShipAny unified theme

### Action required

None. Pure frontend change; no schema, permission, or env change.

### New, no action needed

- `/cuotiben` (记事本) now uses the site-wide ShipAny layout instead of
  its own hardcoded blue/slate styling: the standard `Header`/`Footer`,
  `bg-background`/`bg-card`/`bg-muted` theme tokens, `bg-primary` buttons
  and `border-border` cards, so it matches `/blog`, `/html` and
  `/ai-assistant`. The custom blue header bar and 📒 emoji title are gone;
  the page now shows a plain title plus the `cuotiben.description` line.
- New i18n key: `cuotiben.description` (zh + en). No behavior change:
  the timeline, filters, add/import, expand, toggle-done and delete all
  work as before.

---

## 2026-11-19: Blog split-view reader (display-mode toggle)

### Action required

None. Pure frontend change; no schema, permission, or env change.

### New, no action needed

- `/blog` now has a display-mode toggle (Cards / Split) above the search
  box. The choice is stored in the browser's localStorage
  (`blog-view-mode`) and restored on revisit; default is Cards, so the
  existing grid view is unchanged unless the user switches.
- Split view mirrors the `/html` two-column layout: left column is a
  file-tree nav — “全部” is the collapsible root (chevron toggles it),
  categories are its subdirectories (name + article count, each with its
  own expand/collapse chevron), and articles are files inside their
  category, never listed flat under “全部”. Clicking a category name
  selects it; clicking an article title jumps to it. The active
  article's category auto-expands, so the current article stays visible
  in the tree. Right column shows the selected article's full text
  (title, date, author, categories, image, Markdown/MDX body) fetched
  on demand via `getBlogPostFn`, with Previous / Next buttons to move
  through the articles of the current category and a "第 X 篇 / 共 Y 篇"
  position indicator. Switching category or changing the search resets
  to the first article of that category. Members-only articles still
  show the sign-in prompt instead of the body.
- New i18n keys: `blog.view_grid`, `blog.view_split`,
  `blog.prev_article`, `blog.next_article`, `blog.article_position`,
  `blog.select_article`, `blog.loading_article`, `blog.login_to_read`,
  `blog.sign_in`.

---

## 2026-11-19: Categories & keywords for blog posts and HTML articles

### Action required

- [ ] **Add the `keywords` column to the production database** (SQLite):
      back up `blog.db` first, then run
      `ALTER TABLE blog_html_file ADD COLUMN keywords TEXT NOT NULL DEFAULT '';`
      Blog posts reuse the existing `post.tags` column — no schema change
      there. The `blog_html_file.keywords` column is in the SQLite schema
      template (`src/config/db/schema.sqlite.ts`); the postgres/mysql
      templates do not have the `blog_html_file` table and are untouched.
- [ ] **Rebuild the doc index once**: the fingerprint now includes
      keywords, so the first `loadDocIndex()` after deploy rebuilds
      `data/doc-index.json` automatically. No manual step; only expect one
      slower first assistant query.
- [ ] **Reclassify the onboarding HTML article**: the existing
      《入社培训 · 新人第一周（HTML 版）》 is still `未分类`; change it
      to `新人入学` in the `/html` list (or by updating
      `blog_html_file.category` directly).

### Schema / migration note (deviation from the AGENTS.md workflow)

This project does not use drizzle-kit migrations in production: there is
no `__drizzle_migrations` table and no `drizzle/` directory — the live
database was seeded from `blog-init.db` and is altered by hand. So this
change ships **no drizzle migration file**; the production step above is
the manual `ALTER TABLE`, and `blog-init.db` must be regenerated from the
updated template so a fresh deploy carries the column. If the project
later adopts drizzle-kit migrations, generate one for this column then.

### New, no action needed

- HTML upload/edit categories now come from the taxonomy dictionary
  (`type='category'`, `published`) via `GET /api/blog/html-categories`;
  the old hard-coded `G8学习 / 错题解析 / 工具 / 未分类` list is gone
  from the UI and the API validation. Legacy values already stored on
  articles are kept and still shown in the per-item dropdown.
- Keywords (comma-separated, same convention as categories) can be set
  on blog posts (`post.tags`, admin post editor, below the category
  field) and on HTML articles (`blog_html_file.keywords`, upload form and
  per-item inline input, saved on blur). R2 stores them in
  `customMetadata.keywords`, so both storage backends keep the same API
  contract.
- AI assistant scoring now includes keywords at the same weight as
  categories (title 3 → categories & keywords 2 → description 1).
  Keyword-only doc hits (2 points) stay below the 3-point doc fallback
  threshold (`DOC_KEYWORD_MIN_SCORE`); course ranking has no separate
  threshold. LLM prompts (recommend + Jev) also receive the keywords.
- New i18n keys: `admin.posts.keywords_field`,
  `admin.posts.keywords_placeholder`.

## 2026-11-18: Conversational AI assistant (Dayuan-style chat + system agent tools)

### Action required

- [ ] **Create the read-only assistant agent**: run
      `pnpm admin:token create-agent --name="AI 学习助手" --roles=course-advisor`
      (or the equivalent insert) so `POST /api/ai-assistant/chat` can call
      the registry through `executeAdmin`. Without it the chat still works,
      but course/category reads fall back to the public published list.
      No API key is needed for this agent (in-process only); do not issue
      one unless the agent is later exposed over MCP/REST.

### New, no action needed

- `/ai-assistant` is now a multi-turn chat (messages + history, last 10
  turns sent per request). The LLM decides when to call tools (search
  courses, read a course, list categories, my mentoring status, search
  docs, search the knowledge base for admins) and answers in free-form
  Chinese; greetings and off-topic questions no longer return "not found".
- New endpoint `POST /api/ai-assistant/chat`. The old
  `POST /api/ai-assistant/recommend` is unchanged and still works.
- Course/category reads go through the system agent framework
  (`executeAdmin`, operation registry, `admin_execution` audit) with the
  read-only agent; the Jev hard "off-topic" rejection is removed from the
  chat path (Jev stays in the recommend path). The LLM now does the
  semantic matching from tool results.
- New i18n keys: `ai_assistant.chat_placeholder`, `ai_assistant.send`,
  `ai_assistant.thinking`; `ai_assistant.description` is now conversational.

---

## 2026-11-18: AI assistant MCP (DB-table reads + sysmex-kb + roles)

### Action required

- [ ] **Settings → AI → 知识库 MCP**: fill `kb_mcp_url` (default
      `http://100.117.252.66:8000/mcp`) and `kb_mcp_token` (Bearer token
      for the sysmex-kb MCP). Without the token the assistant skips the
      knowledge-base lookup and keeps working on local docs only.
      Changing the URL later requires re-entering the token (endpoint
      secret protection, see `src/modules/config/service.ts`).

### New, no action needed

- The assistant (`POST /api/ai-assistant/recommend`) now reads the
  `user_status_summary` table directly (permission-scoped: admins see
  all, learners see their own rows by employee number, mentors see
  their mentees by mentor name) and passes the role (销售 / 应用 /
  客服, backend-only for now, no switcher in the page) plus the status
  into the LLM prompts. The response also carries `role` and `status`.
- Every assistant query is recorded as a `user_event`
  (`ai_assistant_query`, mode/routing/found/course count only, never
  the question text), so it shows in the admin user timeline.
- New event kind `ai_assistant_query` (server-only) and timeline label
  `admin.user_detail.timeline_ai_assistant_query` in both locales.

## 2026-11-18: Learner status summary table

### Action required

- [ ] **Schema**: one new table, `user_status_summary` (plan-vs-actual
      snapshot, one row per learner). Port it into `schema.ts` from the
      template for your dialect and apply it (steps 3–4). Nothing existing
      changes.

### New, no action needed

- The table is a **derived snapshot**, rebuilt hourly by an external sync job
  (`sync-user-status.py`): mentoring nodes from the WeCom smart table,
  course progress from ai-shifu MySQL, recent activity from `user_event`.
  It is never the source of truth and can be rebuilt from the sources at any
  time. No new permission codes; the sync writes directly to the wiki
  database.

## 2026-10-17: Per-project session cookies in dev

Browsers share cookies across ports, so several projects running `pnpm dev`
on `localhost` overwrote each other's `better-auth.*` session cookie, and a
reload in one project signed you out of all of them. In dev the cookie prefix
now comes from `AUTH_COOKIE_PREFIX`, or else a slug of `VITE_APP_NAME` (e.g.
`My App` → `my-app.session_token`). Production keeps `better-auth` unless
`AUTH_COOKIE_PREFIX` is set, so deployed users stay signed in.

### Action required

- [ ] **Code that reads `better-auth.session_token` directly**: build the name
      from `getAuthCookiePrefix()` (`@/core/auth`) instead, as
      `src/routes/api/auth/token.ts` does. Otherwise it breaks in dev.
- [ ] **Several local projects with the same `VITE_APP_NAME`**: give each a
      different `AUTH_COOKIE_PREFIX` in `.env.development`.

Local dev sessions sign out once after the upgrade. No schema, permission or
production changes.

---

## 2026-10-17: Appearance settings (off by default)

Admin Settings → General → Appearance gets a master switch, **Enable
appearance settings** (`appearance_enabled`). It is **off by default**, and
while off the site renders exactly from code: the `:root`/`.dark` palette in
`globals.css`, the fonts there, `DEFAULT_APPEARANCE` for the sidebar, light/dark
per visitor, and `<Toaster richColors>`. No `data-theme` attribute or inline
style is put on `<html>`.

Turned on, the admin picks:

- **Light / dark** (`app_color_mode`): the default for visitors who haven't
  picked one. With "Let users pick their own theme color" off, Light or Dark
  is forced on everyone and the toggles are hidden.
- **Site theme** (Classic, Forest, Ocean, Violet, Sunset, Rose, Slate): this
  replaces the code palette (Classic is a layered neutral, not your
  `:root`). The colored themes paint the dashboard sidebar and tint the main
  area.
- **Font** (Inter, System, Rounded, Serif). Self-hosted, OFL-licensed.
- **Font size** (Small, Medium, Large): scales rem, like browser zoom.
- **Sidebar style** (Inset, Floating, Classic = shadcn `variant`) and
  **collapse** (hide completely, or collapse to icons = shadcn `collapsible`).
- **Let users pick their own theme color** (`user_theme_enabled`): adds a
  theme color picker to the user menu (cookie `app_theme`). Users can change
  nothing else.

Appearance fields save on click. Presets live in `src/config/appearance.ts`.

### Action required

- [ ] **Install**: `pnpm install` (adds `@fontsource-variable/nunito` and
      `@fontsource-variable/source-serif-4`).
- [ ] **`src/styles/globals.css`**: the template only _adds_ a "Color themes"
      block and a toast block; `:root`/`.dark` are unchanged. Keep your
      palette and copy those two blocks in.
- [ ] **Dashboard sidebar header** (always on, not behind the switch): the
      brand row is now as tall as the content header, so it lines up with the
      sidebar toggle. It also shows the `VITE_APP_LOGO` image (default
      `/logo.svg`) when that URL loads. Check that your logo looks right
      there. The template's `.env.example` used to point at a missing
      `/logo.png`; fix it in your env files if you copied that.
- [ ] **`<html data-theme>`**: if your project (or a library such as
      daisyUI) already uses `data-theme` on `<html>`, keep the switch off or
      rename one of them.
- [ ] **Customized `__root.tsx`**: keep the template's `ThemeProvider`
      `defaultTheme`/`forcedTheme` and `Toaster richColors` expressions. If you
      had hard-coded `defaultTheme="dark"`, set `DEFAULT_COLOR_MODE = 'dark'`
      in `src/config/appearance.ts` instead.
- [ ] **Customized `app-sidebar.tsx` / `app-layout.tsx` / `user-menu.tsx`**:
      merge the new props (`variant`, `collapsible`, `logo`), and keep sidebar
      text on `sidebar-foreground` tokens so it stays readable on a colored
      sidebar.

No schema, env or permission changes.

---

## 2026-10-12: Activity timeline, product events, admin password reset

### Action required

- [ ] **Schema**: one new table, `user_event` (product events). Port it into
      `schema.ts` from the template for your dialect and apply it (steps 3–4).
      Nothing existing changes.
- [ ] **Permissions**: run step 5 to register `admin.passwords.reset`.
- [ ] **Self-hosted Plausible** (only if admin Settings → Analytics → Plausible
      script URL is a full URL on a host other than `plausible.io`): set the
      server env var `PLAUSIBLE_SCRIPT_HOSTS` to that host, e.g.
      `PLAUSIBLE_SCRIPT_HOSTS=stats.example.com`. On Workers put it in
      wrangler `vars`; on Docker/Node in the container or server env. A
      restart or redeploy is enough. Until it is set, the script does not load
      and saving that URL is refused. This replaces the build-time
      `VITE_PLAUSIBLE_SCRIPT_HOSTS` from 2026-10-11, which still works.
      Same-site proxy paths like `/js/script.js` need nothing.

### New, no action needed

- **Settings save** only validates fields that changed, so a stored
  Plausible URL that no longer passes no longer blocks saving the rest of
  the tab (e.g. the Google Analytics ID). The save error names the host to
  add.

- **Product events**: register kinds in `src/config/events.ts`. Record them
  with `recordEvent()` (`@/modules/events/service`) on the server, or with
  `track()` (`@/lib/track`) from the browser for kinds marked
  `client: true`. Browser reports go through `POST /api/events`, which is
  signed-in only, same-origin only, rate-limited, and capped to a small flat
  detail. `PricingTable` reports `plan_selected`. See AGENTS.md → "Product
  events".
- **Custom timeline sources**: `src/server/admin/timeline-sources.ts` plugs
  rows from the project's own tables into the timeline.
- User detail page: an "Activity" timeline (`users_timeline`,
  `GET /api/admin/users/timeline?userId=`, `users.read`). Built-in events
  come from existing tables, so existing history shows up right away: sign-up,
  orders created, paid, closed and refunded, subscriptions, credit grants and
  charges, AI tasks and tickets. It shows oldest first by default, with a
  toggle. Each row opens its record. The subscriptions and credits admin pages
  now accept `?search=`.
- Admin users list: "Set password" in the row menu
  (`users_set_password`, `POST /api/admin/users/password`). It needs the
  dedicated `admin.passwords.reset` code, which sits outside `admin.users.*`
  so the `admin` role does not pick it up; only `super_admin` has it unless you
  grant it (run step 5 to register the row). It signs the user out everywhere,
  adds an email/password login for OAuth-only users, refuses agent API keys,
  and refuses users whose roles exceed the caller's permissions. The row menu
  is also wider so labels no longer wrap.

---

## 2026-10-11: Atomic writes on D1, payment hardening, Agent API

### Action required

- [ ] **Schema** (additive only, nothing is dropped). Port these into
      `schema.ts`, then apply them (steps 3–4):
  - `user.type`: text, not null, default `'user'`. Agent accounts use `'api'`.
  - `apikey.type`: text, not null, default `'user'`. Agent keys use `'admin'`.
  - `apikey.expires_at`: nullable timestamp_ms. Null means the key never expires.
  - `order.refund_amount`, `order.refunded_at`, `order.refund_result`.
  - The new table `admin_execution`.
  - The `utm_*`, `referrer` and `country` columns on `user`, if the project
    predates them.
- [ ] **Alipay / WeChat Pay**: every product sold through them needs
      `cnyPriceInCents` in `src/config/pricing.ts`. Without it those providers
      now refuse the product. Previously a USD price was silently charged as CNY.
- [ ] **Dependencies**: run `pnpm install`. better-auth is now `^1.7.7`, and
      `seroval`/`seroval-plugins` are pinned to `1.6.8` through pnpm overrides.
- [ ] **Permissions**: run step 5. New codes include `admin.payments.refund`
      and the analytics and agent operations.
- [ ] **Self-hosted Plausible**: superseded by the 2026-10-12 entry (runtime
      `PLAUSIBLE_SCRIPT_HOSTS`, no rebuild). Old text kept for reference: if
      `plausible_src` is a full URL on a host
      other than `plausible.io` (e.g. `https://stats.example.com/js/script.js`),
      add that host to `VITE_PLAUSIBLE_SCRIPT_HOSTS` (comma-separated, exact
      hostnames) and **rebuild**. It is a `VITE_` var, so it is baked into the
      client bundle: put it in `.env.production` or the build environment.
      Setting it only at runtime (or only in wrangler `vars`) does not work.
      Without it the script silently stops loading; the stored setting is kept
      and works again once the host is listed. Also switch any `http://` URL to
      `https://`. Same-site proxy paths such as `/js/script.js` keep working
      with no change.
- [ ] **Initial role**: if `initial_role_name` in admin settings points at a
      role that grants admin access, point it at a non-admin role. Otherwise new
      signups get no role (see "Behavior changes").
- [ ] **Optional data repair (D1 deployments only).** Before this change, a
      write that failed halfway on D1 could leave an order marked paid with no
      credits. Find such orders:
  ```sql
  SELECT o.order_no, o.user_id, o.credits_amount FROM "order" o
  WHERE o.status = 'paid' AND o.credits_amount > 0
    AND NOT EXISTS (SELECT 1 FROM credit c
      WHERE c.order_no = o.order_no AND c.transaction_type = 'grant');
  ```
  Grant the missing credits from the admin console after checking each one.

### Breaking code changes (only if the project calls these directly)

- `deductForRefund(...)` was replaced by `planDeductForRefund(...)`, which
  returns `{ deducted, steps }`. Run the steps with `atomic()`.
- `consume(...)` no longer accepts `tx`. To charge credits together with your
  own writes, use `planConsume(...)` and put its `steps(q)` into the same
  `atomic()` call. `src/modules/ai-tasks/service.ts` shows how.
- `enforceMinIntervalRateLimit` no longer reads cookies. Passing `extraKey`
  now keys the limit to that value, the user id, **instead of** the IP.
- **Move these together:** `src/core/db/atomic.ts`,
  `src/modules/credits/service.ts`, `src/modules/payment/service.ts` and
  `src/modules/ai-tasks/service.ts`.

### Behavior changes users may notice

- **OAuth linking**: signing in with Google or GitHub no longer attaches to an
  existing password account whose email was never verified. This closes the
  pre-registration account takeover.
- **Endpoint secrets**: changing `openai_base_url`, `anthropic_base_url` or
  `r2_endpoint`, `telegram_api_base` or `notify_webhook_url` in settings now
  requires re-entering the matching secret.
- **Uploads**: at most 10 files and 20 MB per request, 10 MB per file. Only
  jpg/png/webp/gif/avif/heic are accepted. SVG is refused because it can carry
  script, and the stored extension comes from the MIME type, never the filename.
- **Rate limits**: requests are now limited per IP, and per user once signed in.
- **Initial role**: a role that grants admin access (`*`, `admin.*`) can't be
  set as `initial_role_name`, and signup also re-checks it. If an existing
  project already points `initial_role_name` at such a role, new users now get
  no role at all (an error is logged). Point it at a non-admin role.
- **Payment test amount**: `<provider>_test_amount` now applies only to users
  with `admin.access`. Everyone else pays the catalog price.
- **Credits**: `consume` rejects amounts that aren't positive integers, and
  fails with "insufficient credits" instead of under-deducting when the
  balance runs out mid-way.
- **Refunds**: refunding requires `admin.payments.refund`. Only `super_admin`
  holds it by default; the `admin` role no longer picks it up through
  `admin.payments.*`.
- **Admin order edit**: the status can only go from an unpaid order
  (`created`/`pending`) to `failed`. Paid, refunding and refunded states change
  only through checkout and refunds. Before this, moving a paid order back to
  pending let the next payment notification grant its credits again.
- **Checkout settlement** additionally requires `paid_at` to be empty and no
  existing grant for the order. New grants use `transaction_no =
grant_<orderNo>`, so the unique index allows one grant per order. Older
  rows keep their numeric transaction numbers.
- **Alipay / WeChat**: notifications are checked against the configured
  `app_id` / `mchid` and the order amount. Mismatches are rejected.
- **Embed IDs are validated**: `google_analytics_id`, `adsense_code`,
  `crisp_website_id`, `tawk_property_id`, `tawk_widget_id` must match their
  provider's format (see `src/lib/embed-ids.ts`), and `plausible_src` must be
  a same-site path or an https URL on `plausible.io` or on a host listed in
  the deployment env `PLAUSIBLE_SCRIPT_HOSTS` (since 2026-10-12; previously
  the build-time `VITE_PLAUSIBLE_SCRIPT_HOSTS`). Bad values are refused on save. Values already stored in the
  database that don't match are no longer rendered, so check these settings
  after upgrading.
- **Checkout return page**: after a successful payment the user now lands on
  `/settings/payments` by default (pricing block, `PricingTable`, and the
  checkout/callback fallbacks). If the project pointed it somewhere else on
  purpose, keep its own `callbackUrl`.
- **Admin search**: the search boxes on users, payments, subscriptions, credits,
  tickets and invite codes are case-insensitive on every database. They also
  match the account's email and name, and an exact user ID. Subscription search
  used to be ignored by the API; it now filters.

### New, no action needed

- `atomic()` / `guard()` in `src/core/db/atomic.ts`. See AGENTS.md
  → "Atomic writes".
- Admin Agent API (`/admin/agent`), the conversion funnel, overview KPIs and the
  `analytics_report` operation. See `docs/admin-agent.md`.
- `src/lib/sql-search.ts` for admin list search.
- `src/components/user-cell.tsx` (`UserCell`): avatar + name + email that
  links to `/admin/users/$id`. Payments, subscriptions, credits and tickets
  open it in a new tab.
- Admin users list: ID column with copy, effective roles column, and a
  `utm_source` filter (`users_sources` operation, `GET /api/admin/users/sources`,
  `users.read`). The subscriptions and credits list APIs now also return
  `userName` / `userImage`.

## 成长路径视频课自动挂接（标题匹配）

- 新表 `growth_course_link`（三份 schema 方言模板均已加，生产库已直建）：
  节点 → blog 已发布视频课的自动挂接，来源 `auto-title`。
- 定时同步 `/home/sysmex/graph-sync/sync-growth-courses.py`（每小时跑，
  与图谱课程同步同目录）：只取 blog 已发布且在 ai-shifu 有视频流
  （outline 含 .m3u8/mp4）的课，按标题 2 字 gram 打分（节点名＋技能＋
  领域名；分数 ≥3、至少 2 个命中 gram 或一个整词命中、且至少 1 个命中
  gram 来自节点名）。生产库现为 7 条链接、6 个节点、7 门课。
- 新接口 `GET /api/growth`（需登录）：返回 growth_course_link 链接＋
  blog 课程实时状态；成长页把匹配到的视频课叠加到节点详情（链到
  blog 文章页，标注“标题自动匹配”），计数与缺口随之实时更新。
- 注意：视频课库以中欧管理沟通类为主，AI 智能体／数字化等节点大多
  仍无匹配课——那是课程缺口，不是匹配失败；缺口数由 27 降到 21。
