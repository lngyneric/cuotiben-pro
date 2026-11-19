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
