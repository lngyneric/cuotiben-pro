import { z } from 'zod';

// The shared contract for REST, MCP, documentation, and permission discovery.
const id = z.string().min(1).max(191);
const short = z.string().max(500);
const text = z.string().max(100_000);
const page = {
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
};
const search = { ...page, search: short.optional() };
const postStatus = z.enum([
  'draft',
  'pending',
  'published',
  'archived',
  'reviewed',
]);
const ticketStatus = z.enum(['open', 'replied', 'closed']);
const postFields = {
  slug: z.string().min(1).max(191),
  title: z.string().min(1).max(500),
  description: text.optional(),
  image: short.optional(),
  content: z.string().max(1_000_000).optional(),
  categories: short.optional(),
  // 关键词：逗号分隔多值文本，存 post.tags，供 AI 助手检索打分。
  tags: short.optional(),
  authorName: short.optional(),
  status: postStatus.optional(),
};
const categoryFields = { slug: id, title: id, description: text.optional() };
const roleFields = { name: id, title: id, description: text.optional() };
const permissionFields = { code: id, resource: id, action: id, title: id };
const strings = z.record(z.string().min(1).max(191), text);
const empty = z.object({}).strict();
const funnelDimensions = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'referrer',
  'country',
] as const;
const funnelDimension = z.enum(funnelDimensions);
const remove = z.object({ id }).strict();

// ─── PPT 图表（阶段 3）：三路数据来源共用的输入形状 ──────────────────────────
// 数据只限三路：inline（直接贴 categories + series）、file（当次传的
// csv/xlsx）、content_source（贴数 + pageSourceRefs 出处）。无数据时
// 服务端明确回“缺数据”，不编示例数字。
const chartSourceRef = z
  .object({
    sourceId: z.string().min(1).max(191),
    sourceKind: z.enum(['upload_text', 'reference_ppt', 'wiki_kb']),
    locator: z.string().min(1).max(191),
  })
  .strict();
const chartDataInput = z
  .object({
    title: z.string().min(1).max(200).optional(),
    categories: z.array(z.string().min(1).max(100)).max(50).optional(),
    series: z
      .array(
        z
          .object({
            name: z.string().min(1).max(100),
            values: z.array(z.number()).max(50),
          })
          .strict()
      )
      .max(8)
      .optional(),
    chartType: z.enum(['bar', 'line', 'pie', 'doughnut']).optional(),
    valueLabels: z
      .enum(['show_all', 'hide_all', 'total_only', 'percent_only'])
      .optional(),
    sourceKind: z.enum(['inline', 'file', 'content_source']).optional(),
    pageSourceRefs: z.array(chartSourceRef).max(10).optional(),
    file: z
      .object({
        name: z.string().min(1).max(191),
        mime: z.string().max(191),
        base64: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
const chartRect = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();
const kpiCardInput = z
  .object({
    title: z.string().min(1).max(60),
    value: z.number(),
    unit: z.string().max(20).optional(),
    fromData: z
      .object({
        series: z.string().min(1).max(100).optional(),
        category: z.string().min(1).max(100).optional(),
        agg: z.enum(['sum', 'value', 'total']).optional(),
      })
      .strict()
      .optional(),
    pageSourceRefs: z.array(chartSourceRef).max(10).optional(),
    slotId: z.string().min(1).max(191).optional(),
    rectIn: chartRect.optional(),
  })
  .strict();
const chartAssignmentInput = z
  .object({
    pageNo: z.number().int().min(1).max(50),
    slotId: z.string().min(1).max(191).optional(),
    rectIn: chartRect.optional(),
    chart: chartDataInput,
    kpiCards: z.array(kpiCardInput).max(4).optional(),
    confirm: z.boolean().optional(),
  })
  .strict();

export interface AdminOperation {
  name: string;
  description: string;
  permission: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  schema: z.ZodType;
  readOnly: boolean;
}
function op(
  name: string,
  description: string,
  permission: string,
  method: AdminOperation['method'],
  path: string,
  schema: z.ZodType
): AdminOperation {
  return {
    name,
    description,
    permission: `admin.${permission}`,
    method,
    path: `/api/admin/${path}`,
    schema,
    readOnly: method === 'GET',
  };
}

export const adminOperations: AdminOperation[] = [
  op(
    'users_list',
    "List users with balances. Search matches email or name; verify an exact email before a write. utm_source filters by exact sign-up source; '' selects untagged (direct) users.",
    'users.read',
    'GET',
    'users',
    z.object({ ...search, utm_source: z.string().max(500).optional() }).strict()
  ),
  op(
    'users_sources',
    'List the most common sign-up utm_source values across all users, with user counts — the valid utm_source filter values for users_list.',
    'users.read',
    'GET',
    'users/sources',
    empty
  ),
  op(
    'users_get',
    'Read one user: profile, sign-up attribution (UTM, referrer, IP, country), roles, and order/credit totals. Use orders_list/credits_list with userId for the records.',
    'users.read',
    'GET',
    'users/{id}',
    remove
  ),
  op(
    'users_timeline',
    "A user's activity timeline: sign-up (with source), orders created/paid/failed/refunded, subscriptions started/canceled, credit grants and charges, AI tasks created/succeeded/failed, tickets opened. order=asc gives oldest first (the user's journey); default desc is newest first. Page by passing nextCursor back as cursor with the same order.",
    'users.read',
    'GET',
    'users/timeline',
    z
      .object({
        userId: id,
        order: z.enum(['asc', 'desc']).optional(),
        cursor: z.string().max(300).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .strict()
  ),
  op(
    'users_set_password',
    "Set a user's sign-in password (adds an email/password login if the user only used OAuth) and sign them out everywhere. Admin console only: rejected for API keys. Cannot target a user whose roles exceed the caller's permissions.",
    'passwords.reset',
    'POST',
    'users/password',
    z.object({ userId: id, password: z.string().min(8).max(128) }).strict()
  ),
  op(
    'credits_adjust',
    'Grant or deduct a positive number of credits for a user. Requires a stable idempotency key.',
    'credits.write',
    'POST',
    'users/credits',
    z
      .object({
        userId: id,
        action: z.enum(['grant', 'deduct']),
        credits: z.number().int().positive().max(1_000_000_000),
        description: short.optional(),
      })
      .strict()
  ),
  op(
    'orders_list',
    'List orders and payment metadata.',
    'payments.read',
    'GET',
    'orders',
    z
      .object({
        ...search,
        userId: id.optional(),
        status: short.optional(),
        paymentType: short.optional(),
      })
      .strict()
  ),
  op(
    'orders_update',
    'Edit local order metadata/status only. Does not charge, refund, grant credits, or synchronize a payment provider.',
    'payments.write',
    'PATCH',
    'orders',
    z
      .object({
        orderNo: id,
        status: z
          .enum(['pending', 'created', 'paid', 'failed', 'refunded', 'deleted'])
          .optional(),
        productId: short.optional(),
        productName: short.optional(),
        description: text.optional(),
      })
      .strict()
  ),
  op(
    'orders_refund',
    "Refund a paid order IN FULL through its payment provider (real money), deduct the credits it granted (default: the order's credits; never below zero), and optionally cancel its subscription immediately. Irreversible.",
    'payments.refund',
    'POST',
    'orders/refund',
    z
      .object({
        orderNo: id,
        reason: short.optional(),
        deductCredits: z.number().int().min(0).max(1_000_000_000).optional(),
        cancelSubscription: z.boolean().optional(),
      })
      .strict()
  ),
  op(
    'analytics_report',
    'Business report for a period, built for scheduled pulls: new users, checkouts, paid orders (new vs renewal), paying and first-time payers, revenue/refunds/net per currency (minor units), checkout→paid and signup→paid rates (0–1, null when no base), subscriptions started/canceled, plus the same metrics for the preceding equal-length period. from/to are ISO timestamps with offset (use the reporting timezone, e.g. from=2026-10-10T00:00:00+08:00&to=2026-10-11T00:00:00+08:00 for one day); default is the last 24 hours; max span 92 days. Agent service accounts are not counted as users.',
    'payments.read',
    'GET',
    'analytics/report',
    z
      .object({
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        compare: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
      })
      .strict()
  ),
  op(
    'analytics_overview',
    'Admin overview KPIs: total and 24h-new users, last-30-day net revenue per currency (renewals included, refunds subtracted, minor units), live subscriptions, open tickets.',
    'payments.read',
    'GET',
    'analytics/overview',
    empty
  ),
  op(
    'analytics_funnel',
    'Signup → checkout → paid conversion (distinct users, renewals excluded) for users who signed up in the window. Filter by first-touch utm_*/referrer/country (empty string = untagged); groupBy picks the breakdown dimension.',
    'payments.read',
    'GET',
    'analytics/funnel',
    z
      .object({
        range: z.enum(['24h', '7d', '30d']).optional(),
        groupBy: funnelDimension.optional(),
        ...Object.fromEntries(
          funnelDimensions.map((d) => [d, z.string().max(500).optional()])
        ),
      })
      .strict()
  ),
  op(
    'subscriptions_list',
    'List subscriptions; this operation does not cancel or modify provider subscriptions.',
    'subscriptions.read',
    'GET',
    'subscriptions',
    z
      .object({ ...page, status: short.optional(), interval: short.optional() })
      .strict()
  ),
  op(
    'credits_list',
    'List credit transactions. The default status filter is active; status=all includes expired and deleted records.',
    'credits.read',
    'GET',
    'credits',
    z
      .object({
        ...search,
        userId: id.optional(),
        status: short.optional(),
        transactionType: z.enum(['grant', 'consume']).optional(),
      })
      .strict()
  ),
  op(
    'categories_list',
    'List categories; all=true returns the complete category dropdown list.',
    'categories.read',
    'GET',
    'categories',
    z
      .object({
        ...search,
        all: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
      })
      .strict()
  ),
  op(
    'categories_create',
    'Create a category.',
    'categories.write',
    'POST',
    'categories',
    z.object(categoryFields).strict()
  ),
  op(
    'categories_update',
    'Update category fields.',
    'categories.write',
    'PUT',
    'categories',
    z
      .object(categoryFields)
      .partial()
      .extend({
        id,
        status: z.enum(['published', 'draft', 'archived']).optional(),
      })
      .strict()
  ),
  op(
    'categories_delete',
    'Soft-delete a category.',
    'categories.delete',
    'DELETE',
    'categories',
    remove
  ),
  op(
    'posts_list',
    'List database posts, or supply id to retrieve one post with its content. Bundled MDX posts are maintained in source files.',
    'posts.read',
    'GET',
    'posts',
    z
      .object({ ...search, id: id.optional(), status: postStatus.optional() })
      .strict()
  ),
  op(
    'posts_create',
    'Create a database post. Use status=draft unless publishing is requested.',
    'posts.write',
    'POST',
    'posts',
    z.object(postFields).strict()
  ),
  op(
    'posts_update',
    'Update a database post; status=published publishes it.',
    'posts.write',
    'PUT',
    'posts',
    z.object(postFields).partial().extend({ id }).strict()
  ),
  op(
    'posts_delete',
    'Archive a database post.',
    'posts.delete',
    'DELETE',
    'posts',
    remove
  ),
  op(
    'posts_batch_status',
    'Set the status of multiple database posts at once (published, draft or reviewed).',
    'posts.write',
    'POST',
    'posts/batch-status',
    z
      .object({
        ids: z.array(id).min(1).max(100),
        status: z.enum(['published', 'draft', 'reviewed']),
      })
      .strict()
  ),
  op(
    'invite_codes_list',
    'List invite codes and their usage.',
    'invite_codes.read',
    'GET',
    'invite-codes',
    z
      .object({ ...search, status: z.enum(['available', 'used']).optional() })
      .strict()
  ),
  op(
    'invite_codes_create',
    'Create one invite code or a batch of up to 100 codes.',
    'invite_codes.write',
    'POST',
    'invite-codes',
    z
      .object({
        code: id.optional(),
        count: z.number().int().min(1).max(100).optional(),
        maxUses: z.number().int().positive().max(1_000_000).optional(),
        trialDays: z.number().int().min(0).max(3650).optional(),
        note: short.optional(),
        expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
      })
      .strict()
  ),
  op(
    'invite_codes_delete',
    'Delete an invite code.',
    'invite_codes.delete',
    'DELETE',
    'invite-codes',
    remove
  ),
  op(
    'permissions_list',
    'List permission definitions.',
    'permissions.read',
    'GET',
    'permissions',
    z.object(search).strict()
  ),
  op(
    'permissions_create',
    'Create a permission definition.',
    'permissions.write',
    'POST',
    'permissions',
    z.object(permissionFields).strict()
  ),
  op(
    'permissions_update',
    'Update a permission definition. Changes affect roles using it.',
    'permissions.write',
    'PUT',
    'permissions',
    z
      .object(permissionFields)
      .partial()
      .extend({ id, description: text.optional() })
      .strict()
  ),
  op(
    'permissions_delete',
    'Delete a permission definition.',
    'permissions.delete',
    'DELETE',
    'permissions',
    remove
  ),
  op(
    'roles_list',
    'List active roles, or supply userId to inspect assigned roles.',
    'roles.read',
    'GET',
    'roles',
    z.object({ ...search, userId: id.optional() }).strict()
  ),
  op(
    'roles_create',
    'Create a role.',
    'roles.write',
    'POST',
    'roles',
    z.object(roleFields).strict()
  ),
  op(
    'roles_update',
    'Update role metadata.',
    'roles.write',
    'PUT',
    'roles',
    z.object(roleFields).partial().extend({ id }).strict()
  ),
  op(
    'roles_delete',
    'Disable a role and its effective permissions.',
    'roles.delete',
    'DELETE',
    'roles',
    remove
  ),
  op(
    'roles_assign',
    'Assign a role to a user; this can increase their privileges.',
    'roles.write',
    'POST',
    'roles/assign',
    z.object({ userId: id, roleId: id }).strict()
  ),
  op(
    'roles_unassign',
    'Remove a role from a user.',
    'roles.write',
    'DELETE',
    'roles/assign',
    z.object({ userId: id, roleId: id }).strict()
  ),
  op(
    'roles_permissions_get',
    'Read the permission IDs assigned to a role.',
    'roles.read',
    'GET',
    'roles/permissions',
    z.object({ roleId: id }).strict()
  ),
  op(
    'roles_permissions_update',
    'Replace ALL permissions of a role. An empty list removes every permission.',
    'roles.write',
    'PUT',
    'roles/permissions',
    z.object({ roleId: id, permissionIds: z.array(id).max(1000) }).strict()
  ),
  op(
    'tickets_list',
    'List support tickets with optional keyword/status filters.',
    'tickets.read',
    'GET',
    'tickets',
    z
      .object({
        ...page,
        keyword: short.optional(),
        status: ticketStatus.optional(),
      })
      .strict()
  ),
  op(
    'tickets_get',
    'Read a ticket, its user, and message history.',
    'tickets.read',
    'GET',
    'tickets/{id}',
    remove
  ),
  op(
    'tickets_reply',
    'Send an administrator reply to a user and mark the ticket replied.',
    'tickets.write',
    'POST',
    'tickets/{id}',
    z
      .object({
        id,
        content: z.string().trim().min(1).max(5000),
        attachments: z.array(z.string().max(2048)).max(9).optional(),
      })
      .strict()
  ),
  op(
    'tickets_update',
    'Close, reopen, or mark a ticket replied.',
    'tickets.write',
    'PATCH',
    'tickets/{id}',
    z.object({ id, status: ticketStatus }).strict()
  ),
  op(
    'settings_get',
    'Read system settings. Secrets are masked and protected keys are excluded.',
    'settings.read',
    'GET',
    'config',
    empty
  ),
  op(
    'settings_update',
    'Update named system settings. Omitted keys are unchanged; masked secret placeholders are preserved.',
    'settings.write',
    'POST',
    'config',
    strings
  ),
  op(
    'custom_settings_get',
    'Read custom settings with secret-like values masked.',
    'settings.read',
    'GET',
    'config/custom',
    empty
  ),
  op(
    'custom_settings_replace',
    'Replace ALL custom settings. Omitted custom keys are deleted; read the current set first.',
    'settings.write',
    'POST',
    'config/custom',
    z
      .object({
        configs: z
          .array(z.object({ key: z.string().max(191), value: text }).strict())
          .max(500),
      })
      .strict()
  ),
  op(
    'settings_test',
    'Test a provider configuration; may send a real email or bot notification. Only call when that test is requested.',
    'settings.write',
    'POST',
    'settings/test',
    z
      .object({
        group: id,
        inputs: strings.optional(),
        configs: strings.optional(),
      })
      .strict()
  ),
  op(
    'presentations_generate',
    'Generate a PPT deck with the intranet wiki Presenton engine (Magpie LLM). Returns a job id immediately — generation takes roughly 1–2 minutes; poll presentations_get until completed/failed, then download. Materials: content text, inline base64 files (total decoded size at most 1.5 MB per call; larger files must be wiki posts), and/or wiki post slugs resolved server-side. At least one of content/files/postSlugs is required; nSlides is 1–50. Modes: standard (default) loads the selected template — default sysmex when template is omitted — and honors the confirmed outline. smart produces only a quick single-page draft: Presenton\'s smart /create endpoint accepts no template, so template is ignored there — never use smart when a template, a specific page count, or multiple pages are required; passing template together with mode smart is rejected. Multi-page rule: standard generation always requires a confirmed outlineId — call presentations_outline first, have the user confirm the page split, then generate with that outlineId (nSlides must equal the outline page count); single-page standard uses a 1-page outline (title + key points). smart produces only a quick single-page draft and skips the outline. Without a confirmed outline the model decides the page count. Title page: titlePage=true keeps a cover as page 1, titlePage=false makes page 1 a content page; default is true for multi-page decks and false for single-page decks. After generation the deck is validated (page count must equal the outline, first slide must match the title-page switch); a mismatch retries once with tightened instructions, then fails with a reason instead of silently returning a wrong deck. Sourced generation (stage 1): pass sourceIds + outlineId from presentations_outline after the user confirms the outline — the deck is then built only from those sources, per page, with provenance in presentations_get (sourceMode, pageSourceRefs); without sources the result is marked sourceMode unsourced ("no-source generation"). Images: pass images [{imageId, pageNo, slotId}] from presentations_image_search/upload — at most 5 images per task, at most 3 pasted screenshots; slots come from the layout registry. Charts (stage 3): pass charts [{pageNo, slotId | rectIn, chart {categories, series, chartType?, valueLabels?, sourceKind?, pageSourceRefs?, file?}, kpiCards?}] — requires a confirmed outlineId; the charts are embedded as native Office charts when the deck completes (at most 5 charts per task). Never paste raw personal data (ID numbers, phone numbers) — send summaries instead.',
    'presentations.generate',
    'POST',
    'presentations/generate',
    z
      .object({
        content: z.string().max(10_000).optional(),
        nSlides: z.number().int().min(1).max(50).optional(),
        language: z.string().max(50).default('Chinese'),
        template: z.string().max(191).optional(),
        mode: z.enum(['standard', 'smart']).default('standard'),
        titlePage: z.boolean().optional(),
        instructions: z.string().max(2000).optional(),
        files: z
          .array(
            z
              .object({
                name: z.string().min(1).max(191),
                mime: z.string().max(191),
                base64: z.string().min(1),
              })
              .strict()
          )
          .max(10)
          .optional(),
        postSlugs: z.array(z.string().min(1).max(191)).max(10).optional(),
        sourceIds: z.array(z.string().min(1).max(191)).max(10).optional(),
        outlineId: z.string().min(1).max(191).optional(),
        images: z
          .array(
            z
              .object({
                imageId: z.string().min(1).max(191),
                pageNo: z.number().int().min(1).max(50),
                slotId: z.string().min(1).max(191).optional(),
              })
              .strict()
          )
          .max(5)
          .optional(),
        charts: z.array(chartAssignmentInput).max(5).optional(),
      })
      .strict()
  ),
  op(
    'presentations_source_add',
    'Register one PPT content source (stage 1). kind upload_text: a text file (txt/md/csv/pdf/docx/xls/xlsx) is extracted server-side — single file at most 8000 chars, all sources together at most 16000 chars, over the limit is rejected, never silently truncated. kind reference_ppt: a .pptx file is extracted per slide (titles + theme colors); single file at most 25 MB — over 25 MB is rejected with a hint to convert to PDF (as a content source) or images (as a layout reference); use is content, style, or both. kind wiki_kb: pass keyword to search only published wiki content visible to the caller (drafts and content the caller cannot view never appear) and get a hit list to select from; pass postIds [{refType: post|html, refId}] to register the selected hits. Empty extraction registers as status empty and cannot enter an outline. Only extracted/retrieved content is used for generation — nothing is invented.',
    'presentations.generate',
    'POST',
    'presentations/sources',
    z
      .object({
        kind: z.enum(['upload_text', 'reference_ppt', 'wiki_kb']),
        file: z
          .object({
            name: z.string().min(1).max(191),
            mime: z.string().max(191),
            base64: z.string().min(1),
          })
          .strict()
          .optional(),
        keyword: z.string().max(200).optional(),
        postIds: z
          .array(
            z
              .object({
                refType: z.enum(['post', 'html']),
                refId: z.string().min(1).max(191),
              })
              .strict()
          )
          .max(10)
          .optional(),
        use: z.enum(['content', 'style', 'both']).optional(),
      })
      .strict()
  ),
  op(
    'presentations_outline',
    'Build a page-split draft from registered PPT content sources (stage 1): one page per topic (upload text split by headings/paragraphs, one reference-PPT slide per page, one wiki article per page), each page with title, key points, chosen layout (A–H) with reason, and its source refs. Upload sources take priority over wiki_kb (supplementary only). Pages whose source fragment is too thin are marked insufficient (title + points only, never expanded). Returns outlineId + pages as a draft — the user must confirm it (presentations_outline_confirm) before presentations_generate accepts it.',
    'presentations.generate',
    'POST',
    'presentations/outline',
    z
      .object({
        sourceIds: z.array(z.string().min(1).max(191)).min(1).max(10),
      })
      .strict()
  ),
  op(
    'presentations_outline_confirm',
    'Confirm a PPT page-split draft (stage 1). Optionally pass the full pages array to adjust titles, points, or layouts (page numbers must stay 1..N consecutive; sources must be the registered ones); confirming without pages accepts the draft as-is. Only a confirmed outline may be used by presentations_generate. Confirming bumps the version; the previous version is not kept as a separate row.',
    'presentations.generate',
    'POST',
    'presentations/outline/confirm',
    z
      .object({
        outlineId: z.string().min(1).max(191),
        pages: z
          .array(
            z
              .object({
                pageNo: z.number().int().min(1).max(50),
                title: z.string().min(1).max(200),
                points: z.array(z.string().max(500)).max(10),
                layout: z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']),
                layoutReason: z.string().max(500),
                sources: z
                  .array(
                    z
                      .object({
                        sourceId: z.string().min(1).max(191),
                        sourceKind: z.enum([
                          'upload_text',
                          'reference_ppt',
                          'wiki_kb',
                        ]),
                        locator: z.string().min(1).max(191),
                      })
                      .strict()
                  )
                  .min(1),
                primaryKind: z.enum([
                  'upload_text',
                  'reference_ppt',
                  'wiki_kb',
                ]),
                insufficient: z.boolean().optional(),
                note: z.string().max(500).optional(),
                styleRef: z
                  .object({
                    sourceId: z.string().min(1).max(191),
                    note: z.string().max(500),
                  })
                  .strict()
                  .optional(),
              })
              .strict()
          )
          .max(50)
          .optional(),
      })
      .strict()
  ),
  op(
    'presentations_image_upload',
    'Upload an image or paste a screenshot for PPT use (stage 1, no image generation). The file is stored in the wiki file storage (R2 or local uploads) and only metadata is kept; returns image_id. Accepts png/jpg/jpeg/gif/webp (no SVG), single file at most 5 MB decoded. Per-task limits: at most 5 images total, at most 3 pasted screenshots — library picks and new uploads count together.',
    'presentations.generate',
    'POST',
    'presentations/images',
    z
      .object({
        file: z
          .object({
            name: z.string().min(1).max(191),
            mime: z.string().max(191),
            base64: z.string().min(1),
          })
          .strict(),
        sourceType: z.enum(['upload', 'paste']).default('upload'),
        tags: z.string().max(500).optional(),
      })
      .strict()
  ),
  op(
    'presentations_image_search',
    "Search existing images for PPT use (stage 1, no image generation): the caller's own uploads/pastes, cover images of published blog articles, and images embedded in /wiki/html pages the caller may view. Filter by filename/tag text (q), tags, or source type (wiki_blog/wiki_html/upload/paste); sort recent orders by last use. Images the caller cannot view never appear. Returns image_id, source ref, dimensions, and owner for each candidate.",
    'presentations.read',
    'POST',
    'presentations/images/search',
    z
      .object({
        q: z.string().max(200).optional(),
        tags: z.string().max(500).optional(),
        sourceType: z
          .enum(['wiki_blog', 'wiki_html', 'upload', 'paste'])
          .optional(),
        sort: z.enum(['recent', 'newest']).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict()
  ),
  op(
    'presentations_get',
    'Read one PPT generation job. Only the agent account that created the job can read it — other callers get a 404. When completed, downloadUrl is the complete absolute download URL — use it as-is as the download link and never ask the user for the site address; Presenton edit URLs are never returned.',
    'presentations.read',
    'GET',
    'presentations/{id}',
    remove
  ),
  op(
    'presentations_page_get',
    'List the elements of one page of a completed PPT deck (stage 2): element_id, type (text/shape/image/chart), current text or properties, and the layout slot each element sits in. Call this before any page edit to locate elements by id — never guess coordinates. Only the agent account that created the job can read it — other callers get a 404. editable=false means the deck has no element ids (a legacy deck): single-page editing is not supported for it, do not try to edit it.',
    'presentations.read',
    'POST',
    'presentations/page',
    z
      .object({
        jobId: z.string().min(1).max(191),
        pageNo: z.number().int().min(1).max(50),
      })
      .strict()
  ),
  op(
    'presentations_page_edit',
    'Edit exactly one page of a completed PPT deck (stage 2, native editable objects only — text stays a text box, shapes stay shapes, pictures stay pictures). Pass jobId, pageNo, and an ops list (at most 20 ops): set_text {elementId, text} changes only the text (position, size and color are untouched unless the same request says otherwise); set_style {elementId, color?, fontSizePt?, bold?, align?} — color must be a theme color (#2F5597, #003266, #005B9F, #27AE60, #ED7D31, #9DC3E6, #D9DEE6, #F7F9FC) or a color the user explicitly gave (set explicitColor=true to assert so; never invent a color); move/resize {elementId, slotId | rectIn} — target by layout slot id or an explicit {x, y, width, height} rectangle in inches; out-of-bounds is rejected, never silently clipped; replace_image {elementId, imageId} swaps the picture for an image from presentations_image_search/upload (cover-cropped into the slot, never stretched); add_element {kind: text|shape, text?, slotId | rectIn, color?}; delete_element {elementId}. Only the named page is rewritten — all other pages stay byte-identical. Destructive ops (delete_element, replace_image) and screenshot mode (referenceImageId, an image_id from the image library) first return a proposed change list (requiresConfirmation=true, nothing is written) — show it to the user and re-call with confirm=true to execute. Plain spoken set_text/set_style/move/resize/add_element execute immediately. Each executed edit bumps the version; the returned pagePreview is the edited page element list (not a rendered image — the server has no renderer) and downloadUrl points at the new full deck. Legacy decks without element ids are refused with a clear message.',
    'presentations.generate',
    'POST',
    'presentations/page/edit',
    z
      .object({
        jobId: z.string().min(1).max(191),
        pageNo: z.number().int().min(1).max(50),
        ops: z
          .array(
            z
              .object({
                op: z.enum([
                  'set_text',
                  'set_style',
                  'move',
                  'resize',
                  'replace_image',
                  'add_element',
                  'delete_element',
                ]),
                elementId: z.string().min(1).max(191).optional(),
                text: z.string().max(5000).optional(),
                color: z.string().max(20).optional(),
                explicitColor: z.boolean().optional(),
                fontSizePt: z.number().min(6).max(100).optional(),
                bold: z.boolean().optional(),
                align: z.enum(['left', 'center', 'right']).optional(),
                slotId: z.string().min(1).max(191).optional(),
                rectIn: z
                  .object({
                    x: z.number(),
                    y: z.number(),
                    width: z.number(),
                    height: z.number(),
                  })
                  .strict()
                  .optional(),
                imageId: z.string().min(1).max(191).optional(),
                kind: z.enum(['text', 'shape']).optional(),
              })
              .strict()
          )
          .min(1)
          .max(20),
        referenceImageId: z.string().min(1).max(191).optional(),
        confirm: z.boolean().optional(),
      })
      .strict()
  ),
  op(
    'presentations_page_revert',
    'Roll back a PPT deck to an earlier single-page-edit version (stage 2): pass jobId and version (0 = the original Presenton deck). A new version is created copying that version — history is never deleted — and the download link then points at the rolled-back deck. Only the agent account that created the job can revert it — other callers get a 404.',
    'presentations.generate',
    'POST',
    'presentations/page/revert',
    z
      .object({
        jobId: z.string().min(1).max(191),
        version: z.number().int().min(0),
      })
      .strict()
  ),
  op(
    'presentations_chart_add',
    'Insert one native editable chart into one page of a completed PPT deck (stage 3): the chart is a real Office chart object (c:chart + embedded xlsx workbook) — in PowerPoint it can be double-clicked to edit the data or change the type; it is never a chart picture. Pass jobId, pageNo, and slotId (a layout-registry slot, e.g. a G/H main_image slot) or an explicit rectIn {x, y, width, height} in inches, plus chart {title?, categories, series [{name, values}], chartType? (bar/line/pie/doughnut — omitted means auto-selected by data shape and noted as auto), valueLabels? (show_all/hide_all/total_only/percent_only, default show_all), sourceKind? (inline/file/content_source, default inline), pageSourceRefs?, file?}. Data comes only from three sources: numbers pasted inline, a csv/xlsx file passed as file (first row = header with series names, first column = categories), or content-source data with pageSourceRefs [{sourceId, sourceKind, locator}] pointing at sources the caller registered. With no data the call is refused with "missing data" — no sample numbers are ever invented. A chart type that clearly mismatches the data (e.g. pie with many categories, line with non-time categories) first returns a proposal (requiresConfirmation=true with suggestedType) — show it to the user and re-call with confirm=true to proceed with the requested type; pie/doughnut with multiple series or negative values is rejected outright. Optional kpiCards [{title, value, unit?, fromData? {series?, category?, agg? sum|value|total}, pageSourceRefs?, slotId?, rectIn?}] add a Dashboard number strip on the same page (deep navy cards, white 26pt numbers, same style as the November one-pager data strip; Dashboard pages use layout A, G or H): each card value must come from the same page data (fromData) or cite a content source (pageSourceRefs) — a card with neither is rejected, so cards and charts never use two different sets of numbers. Only the named page is rewritten — all other pages stay byte-identical. Each executed insert bumps the version; the returned pagePreview is the edited page element list (not a rendered image — the server has no renderer) and downloadUrl points at the new full deck. Legacy decks without element ids are refused with a clear message.',
    'presentations.generate',
    'POST',
    'presentations/charts',
    z
      .object({
        jobId: z.string().min(1).max(191),
        pageNo: z.number().int().min(1).max(50),
        slotId: z.string().min(1).max(191).optional(),
        rectIn: chartRect.optional(),
        chart: chartDataInput,
        kpiCards: z.array(kpiCardInput).max(4).optional(),
        confirm: z.boolean().optional(),
      })
      .strict()
  ),
  op(
    'presentations_chart_update',
    'Change an existing native chart in a completed PPT deck (stage 3): replace its data, change its type, or switch its value labels. Pass jobId, pageNo, elementId (find it with presentations_page_get — type chart), and only what changes: data {categories, series} with sourceKind? (inline/file/content_source) + pageSourceRefs?/file? to replace the data (same three-source rule as presentations_chart_add — no data is ever invented), chartType? (bar/line/pie/doughnut), valueLabels? (show_all/hide_all/total_only/percent_only), title?. Switching valueLabels only changes the label layer — the data and axes stay untouched. A type that clearly mismatches the (new) data first returns a proposal (requiresConfirmation=true with suggestedType) — re-call with confirm=true to proceed. Only the chart part (and the embedded workbook when data changes) is rewritten — the slide XML is untouched and all other pages stay byte-identical. Each executed update bumps the version; pagePreview is the edited page element list (not a rendered image) and downloadUrl points at the new full deck.',
    'presentations.generate',
    'POST',
    'presentations/charts/update',
    z
      .object({
        jobId: z.string().min(1).max(191),
        pageNo: z.number().int().min(1).max(50),
        elementId: z.string().min(1).max(191),
        data: z
          .object({
            categories: z.array(z.string().min(1).max(100)).max(50).optional(),
            series: z
              .array(
                z
                  .object({
                    name: z.string().min(1).max(100),
                    values: z.array(z.number()).max(50),
                  })
                  .strict()
              )
              .max(8)
              .optional(),
          })
          .strict()
          .optional(),
        sourceKind: z.enum(['inline', 'file', 'content_source']).optional(),
        pageSourceRefs: z.array(chartSourceRef).max(10).optional(),
        file: z
          .object({
            name: z.string().min(1).max(191),
            mime: z.string().max(191),
            base64: z.string().min(1),
          })
          .strict()
          .optional(),
        chartType: z.enum(['bar', 'line', 'pie', 'doughnut']).optional(),
        valueLabels: z
          .enum(['show_all', 'hide_all', 'total_only', 'percent_only'])
          .optional(),
        title: z.string().max(200).optional(),
        confirm: z.boolean().optional(),
      })
      .strict()
  ),
];

export const adminScopes = [
  ...new Set(adminOperations.map((operation) => operation.permission)),
].sort();
export const envelopeSchema = {
  type: 'object',
  properties: {
    code: { type: 'integer' },
    message: { type: 'string' },
    data: {},
  },
  required: ['code', 'message'],
} as const;
export function operationDescriptor(operation: AdminOperation) {
  const { schema, ...metadata } = operation;
  return {
    ...metadata,
    inputSchema: z.toJSONSchema(schema, { io: 'input' }),
    outputSchema: envelopeSchema,
    requiresIdempotencyKey: !operation.readOnly,
  };
}
