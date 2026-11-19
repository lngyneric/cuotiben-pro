/**
 * PostgreSQL schema definitions.
 *
 * This is the PostgreSQL dialect of the database schema.
 * To use: set DATABASE_PROVIDER=postgres in .env.local,
 * then copy this file's content into schema.ts.
 */

import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const table = pgTable;

// ─── Auth ────────────────────────────────────────────────────────────────────

export const user = table(
  'user',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    image: text('image'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    utmSource: text('utm_source').notNull().default(''),
    ip: text('ip').notNull().default(''),
    locale: text('locale').notNull().default(''),
    utmCampaign: text('utm_campaign').notNull().default(''),
    utmTerm: text('utm_term').notNull().default(''),
    utmMedium: text('utm_medium').notNull().default(''),
    utmContent: text('utm_content').notNull().default(''),
    referrer: text('referrer').notNull().default(''),
    country: text('country').notNull().default(''),
    // 'user' = a person; 'api' = an agent/service account (no login, keys only).
    type: text('type').notNull().default('user'),
  },
  (table) => [
    index('idx_user_name').on(table.name),
    index('idx_user_created_at').on(table.createdAt),
  ]
);

export const session = table(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('idx_session_user_expires').on(table.userId, table.expiresAt),
  ]
);

export const account = table(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_account_user_id').on(table.userId),
    index('idx_account_provider_account').on(table.providerId, table.accountId),
  ]
);

export const verification = table(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('idx_verification_identifier').on(table.identifier)]
);

// ─── Content ─────────────────────────────────────────────────────────────────

export const config = table('config', {
  name: text('name').unique().notNull(),
  value: text('value'),
});

export const taxonomy = table(
  'taxonomy',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    slug: text('slug').unique().notNull(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    image: text('image'),
    icon: text('icon'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
    sort: integer('sort').default(0).notNull(),
  },
  (table) => [index('idx_taxonomy_type_status').on(table.type, table.status)]
);

export const post = table(
  'post',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    slug: text('slug').unique().notNull(),
    type: text('type').notNull(),
    title: text('title'),
    description: text('description'),
    image: text('image'),
    content: text('content'),
    categories: text('categories'),
    tags: text('tags'),
    authorName: text('author_name'),
    authorImage: text('author_image'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
    sort: integer('sort').default(0).notNull(),
  },
  (table) => [index('idx_post_type_status').on(table.type, table.status)]
);

// ─── Business ────────────────────────────────────────────────────────────────

export const order = table(
  'order',
  {
    id: text('id').primaryKey(),
    orderNo: text('order_no').unique().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userEmail: text('user_email'),
    status: text('status').notNull(),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    productId: text('product_id'),
    paymentType: text('payment_type'),
    paymentInterval: text('payment_interval'),
    paymentProvider: text('payment_provider').notNull(),
    paymentSessionId: text('payment_session_id'),
    checkoutInfo: text('checkout_info').notNull(),
    checkoutResult: text('checkout_result'),
    paymentResult: text('payment_result'),
    discountCode: text('discount_code'),
    discountAmount: integer('discount_amount'),
    discountCurrency: text('discount_currency'),
    paymentEmail: text('payment_email'),
    paymentAmount: integer('payment_amount'),
    paymentCurrency: text('payment_currency'),
    paidAt: timestamp('paid_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
    description: text('description'),
    productName: text('product_name'),
    subscriptionId: text('subscription_id'),
    subscriptionResult: text('subscription_result'),
    checkoutUrl: text('checkout_url'),
    callbackUrl: text('callback_url'),
    creditsAmount: integer('credits_amount'),
    creditsValidDays: integer('credits_valid_days'),
    planName: text('plan_name'),
    paymentProductId: text('payment_product_id'),
    invoiceId: text('invoice_id'),
    invoiceUrl: text('invoice_url'),
    subscriptionNo: text('subscription_no'),
    transactionId: text('transaction_id'),
    paymentUserName: text('payment_user_name'),
    paymentUserId: text('payment_user_id'),
    refundAmount: integer('refund_amount'),
    refundedAt: timestamp('refunded_at'),
    refundResult: text('refund_result'),
  },
  (table) => [
    index('idx_order_user_status_payment_type').on(
      table.userId,
      table.status,
      table.paymentType
    ),
    index('idx_order_transaction_provider').on(
      table.transactionId,
      table.paymentProvider
    ),
    index('idx_order_created_at').on(table.createdAt),
  ]
);

export const subscription = table(
  'subscription',
  {
    id: text('id').primaryKey(),
    subscriptionNo: text('subscription_no').unique().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userEmail: text('user_email'),
    status: text('status').notNull(),
    paymentProvider: text('payment_provider').notNull(),
    subscriptionId: text('subscription_id').notNull(),
    subscriptionResult: text('subscription_result'),
    productId: text('product_id'),
    description: text('description'),
    amount: integer('amount'),
    currency: text('currency'),
    interval: text('interval'),
    intervalCount: integer('interval_count'),
    trialPeriodDays: integer('trial_period_days'),
    currentPeriodStart: timestamp('current_period_start'),
    currentPeriodEnd: timestamp('current_period_end'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
    planName: text('plan_name'),
    billingUrl: text('billing_url'),
    productName: text('product_name'),
    creditsAmount: integer('credits_amount'),
    creditsValidDays: integer('credits_valid_days'),
    paymentProductId: text('payment_product_id'),
    paymentUserId: text('payment_user_id'),
    canceledAt: timestamp('canceled_at'),
    canceledEndAt: timestamp('canceled_end_at'),
    canceledReason: text('canceled_reason'),
    canceledReasonType: text('canceled_reason_type'),
  },
  (table) => [
    index('idx_subscription_user_status_interval').on(
      table.userId,
      table.status,
      table.interval
    ),
    index('idx_subscription_provider_id').on(
      table.subscriptionId,
      table.paymentProvider
    ),
    index('idx_subscription_created_at').on(table.createdAt),
  ]
);

export const credit = table(
  'credit',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userEmail: text('user_email'),
    orderNo: text('order_no'),
    subscriptionNo: text('subscription_no'),
    transactionNo: text('transaction_no').unique().notNull(),
    transactionType: text('transaction_type').notNull(),
    transactionScene: text('transaction_scene'),
    credits: integer('credits').notNull(),
    remainingCredits: integer('remaining_credits').notNull().default(0),
    description: text('description'),
    expiresAt: timestamp('expires_at'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
    consumedDetail: text('consumed_detail'),
    metadata: text('metadata'),
  },
  (table) => [
    index('idx_credit_consume_fifo').on(
      table.userId,
      table.status,
      table.transactionType,
      table.remainingCredits,
      table.expiresAt
    ),
    index('idx_credit_order_no').on(table.orderNo),
    index('idx_credit_subscription_no').on(table.subscriptionNo),
  ]
);

export const apikey = table(
  'apikey',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    keyHash: text('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    key: text('key'),
    title: text('title').notNull(),
    status: text('status').notNull(),
    lastUsedAt: timestamp('last_used_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
    // 'user' = product API key (sk_); 'admin' = admin/agent API key (sa_admin_).
    type: text('type').notNull().default('user'),
    expiresAt: timestamp('expires_at'), // null = never expires
  },
  (table) => [
    index('idx_apikey_user_status').on(table.userId, table.status),
    index('idx_apikey_keyhash_status').on(table.keyHash, table.status),
  ]
);

// ─── RBAC ────────────────────────────────────────────────────────────────────

export const role = table(
  'role',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    sort: integer('sort').default(0).notNull(),
  },
  (table) => [index('idx_role_status').on(table.status)]
);

export const permission = table(
  'permission',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull().unique(),
    resource: text('resource').notNull(),
    action: text('action').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_permission_resource_action').on(table.resource, table.action),
  ]
);

export const rolePermission = table(
  'role_permission',
  {
    id: text('id').primaryKey(),
    roleId: text('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
    permissionId: text('permission_id')
      .notNull()
      .references(() => permission.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    index('idx_role_permission_role_permission').on(
      table.roleId,
      table.permissionId
    ),
  ]
);

export const userRole = table(
  'user_role',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    expiresAt: timestamp('expires_at'),
  },
  (table) => [
    index('idx_user_role_user_expires').on(table.userId, table.expiresAt),
  ]
);

// ─── AI ──────────────────────────────────────────────────────────────────────

export const aiTask = table(
  'ai_task',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    mediaType: text('media_type').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    prompt: text('prompt').notNull(),
    options: text('options'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
    taskId: text('task_id'),
    taskInfo: text('task_info'),
    taskResult: text('task_result'),
    costCredits: integer('cost_credits').notNull().default(0),
    scene: text('scene').notNull().default(''),
    creditId: text('credit_id'),
  },
  (table) => [
    index('idx_ai_task_user_media_type').on(table.userId, table.mediaType),
    index('idx_ai_task_media_type_status').on(table.mediaType, table.status),
  ]
);

export const chat = table(
  'chat',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    model: text('model').notNull(),
    provider: text('provider').notNull(),
    title: text('title').notNull().default(''),
    parts: text('parts').notNull(),
    metadata: text('metadata'),
    content: text('content'),
  },
  (table) => [index('idx_chat_user_status').on(table.userId, table.status)]
);

export const chatMessage = table(
  'chat_message',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    chatId: text('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    role: text('role').notNull(),
    parts: text('parts').notNull(),
    metadata: text('metadata'),
    model: text('model').notNull(),
    provider: text('provider').notNull(),
  },
  (table) => [
    index('idx_chat_message_chat_id').on(table.chatId, table.status),
    index('idx_chat_message_user_id').on(table.userId, table.status),
  ]
);

// ─── Types ───────────────────────────────────────────────────────────────────

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;
export type Account = typeof account.$inferSelect;
export type NewAccount = typeof account.$inferInsert;
export type Verification = typeof verification.$inferSelect;
export type Config = typeof config.$inferSelect;
export type Taxonomy = typeof taxonomy.$inferSelect;
export type NewTaxonomy = typeof taxonomy.$inferInsert;
export type Post = typeof post.$inferSelect;
export type NewPost = typeof post.$inferInsert;
export type Order = typeof order.$inferSelect;
export type NewOrder = typeof order.$inferInsert;
export type Subscription = typeof subscription.$inferSelect;
export type NewSubscription = typeof subscription.$inferInsert;
export type Credit = typeof credit.$inferSelect;
export type NewCredit = typeof credit.$inferInsert;
export type Apikey = typeof apikey.$inferSelect;
export type NewApikey = typeof apikey.$inferInsert;
export type Role = typeof role.$inferSelect;
export type NewRole = typeof role.$inferInsert;
export type Permission = typeof permission.$inferSelect;
export type RolePermission = typeof rolePermission.$inferSelect;
export type UserRole = typeof userRole.$inferSelect;
export type AiTask = typeof aiTask.$inferSelect;
export type NewAiTask = typeof aiTask.$inferInsert;
export type Chat = typeof chat.$inferSelect;
export type NewChat = typeof chat.$inferInsert;
export type ChatMessage = typeof chatMessage.$inferSelect;
export type NewChatMessage = typeof chatMessage.$inferInsert;

// ─── Tickets (support) ───────────────────────────────────────────────────────

export const ticket = table(
  'ticket',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    title: text('title').notNull(),
    status: text('status').notNull().default('open'), // open | replied | closed
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_ticket_user').on(t.userId),
    index('idx_ticket_status').on(t.status),
  ]
);

export const ticketMessage = table(
  'ticket_message',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => ticket.id),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    role: text('role').notNull().default('user'), // user | admin
    content: text('content').notNull(),
    attachments: text('attachments').notNull().default('[]'), // JSON array of image URLs
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('idx_ticket_message_ticket').on(t.ticketId)]
);

export type Ticket = typeof ticket.$inferSelect;
export type NewTicket = typeof ticket.$inferInsert;
export type TicketMessage = typeof ticketMessage.$inferSelect;
export type NewTicketMessage = typeof ticketMessage.$inferInsert;

// ─── Custom tables ───────────────────────────────────────────────────────────
// Add your own tables below this line.

// ─── Invite Codes ────────────────────────────────────────────────────────────

export const inviteCode = table(
  'invite_code',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull().unique(),
    maxUses: integer('max_uses').notNull().default(1),
    usedCount: integer('used_count').notNull().default(0),
    trialDays: integer('trial_days').notNull().default(15),
    note: text('note').default(''),
    createdBy: text('created_by').references(() => user.id),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('idx_invite_code_code').on(t.code)]
);

export const userInvite = table(
  'user_invite',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    inviteCodeId: text('invite_code_id')
      .notNull()
      .references(() => inviteCode.id),
    activatedAt: timestamp('activated_at').defaultNow().notNull(),
    trialEndsAt: timestamp('trial_ends_at').notNull(),
  },
  (t) => [
    index('idx_user_invite_user').on(t.userId),
    index('idx_user_invite_code').on(t.inviteCodeId),
  ]
);

export type InviteCode = typeof inviteCode.$inferSelect;
export type NewInviteCode = typeof inviteCode.$inferInsert;
export type UserInvite = typeof userInvite.$inferSelect;
export type NewUserInvite = typeof userInvite.$inferInsert;

// Agent administration: durable execution journal. Agents are `user.type = 'api'`
// accounts whose credentials are `apikey.type = 'admin'` rows; tokenId → apikey.id.
export const adminExecution = table(
  'admin_execution',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    tokenId: text('token_id'),
    operation: text('operation').notNull(),
    inputHash: text('input_hash').notNull(),
    targetId: text('target_id'),
    status: text('status').notNull(),
    response: text('response'),
    createdAt: timestamp('created_at').notNull(),
    completedAt: timestamp('completed_at'),
  },
  (t) => [index('idx_admin_execution_created').on(t.createdAt)]
);

export type AdminExecution = typeof adminExecution.$inferSelect;

// Product events (paywall hits, plan picks, risk flags …) that no other table
// records. Kinds are registered in src/config/events.ts; written through
// recordEvent() (server) or track() (client, registered kinds only). Shown in
// the admin user timeline next to orders, credits and tasks.
export const userEvent = table(
  'user_event',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    detail: text('detail'),
    source: text('source').notNull(), // server | client
    createdAt: timestamp('created_at').notNull(),
  },
  (t) => [
    index('idx_user_event_user_created').on(t.userId, t.createdAt),
    index('idx_user_event_kind_created').on(t.kind, t.createdAt),
  ]
);

export type UserEvent = typeof userEvent.$inferSelect;
export type NewUserEvent = typeof userEvent.$inferInsert;

// Learner status summary: derived plan-vs-actual snapshot, rebuilt hourly by
// the sync job (see user-status-summary-spec.md). Never the source of truth —
// every fact lives in its home system (WeCom smart table for mentoring nodes,
// ai-shifu MySQL for course progress, wiki user_event for recent activity).
// One row per smart-table row (one mentoring record); id is
// `record:<RECORD_ID>`. One person can have two records, so the employee
// number is a column, not the key. Rows whose identity could not be resolved are
// still written with the `unresolved_identity` flag and reported by the sync
// job, never silently dropped.
export const userStatusSummary = table(
  'user_status_summary',
  {
    id: text('id').primaryKey(),
    employeeNo: text('employee_no'),
    wecomUserId: text('wecom_user_id'),
    wikiUserId: text('wiki_user_id'),
    aishifuUserBid: text('aishifu_user_bid'),
    name: text('name').notNull(),
    department: text('department'),
    positionName: text('position_name'),
    mentorLeadId: text('mentor_lead_id'),
    mentorLeadName: text('mentor_lead_name'),
    mentors: text('mentors'), // JSON: {lead, keyAccount, exempt, departmentHead} with WeCom ids + names
    planType: text('plan_type'),
    planStartDate: text('plan_start_date'), // ISO date
    planEndDate: text('plan_end_date'), // ISO date
    expectedDate: text('expected_date'), // ISO date
    plan: text('plan'), // JSON: {nodes: [{node, expected}]}
    actual: text('actual'), // JSON: {status, result, nodeRatings, confirmations, scores, courses, lastActivityAt}
    flags: text('flags'), // JSON array: overdue | pending_confirm | no_course_activity | no_wiki_account | unresolved_identity
    planVersion: text('plan_version').notNull().default('v1'),
    sourceWatermarks: text('source_watermarks'), // JSON: {smartsheetEditedAt, aishifuMaxUpdatedAt, wikiMaxEventAt}
    computedAt: timestamp('computed_at').notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    index('idx_user_status_employee').on(t.employeeNo),
    index('idx_user_status_wecom').on(t.wecomUserId),
    index('idx_user_status_mentor').on(t.mentorLeadId),
    index('idx_user_status_department').on(t.department),
  ]
);

export type UserStatusSummary = typeof userStatusSummary.$inferSelect;
export type NewUserStatusSummary = typeof userStatusSummary.$inferInsert;

// ─── Graph: 角色人员对应表（企微智能表快照，人员轴数据源）───────────────
// 由主机定时脚本 sync-role-person-map.py 从学分制带教智能表「角色人员对应表」
// 全量同步；一人一行，主键 id = wecom_user_id 或 `name:<姓名>`（无 id 时）。
export const rolePersonMap = table(
  'role_person_map',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    employeeNo: text('employee_no'),
    wecomUserId: text('wecom_user_id'),
    role: text('role').notNull(), // 学员 | 导师 | 两者都是
    mentorTypes: text('mentor_types'), // JSON 数组：带教负责人 / 大客户带教 / 生免带教
    mentees: text('mentees'), // JSON 数组：[{name, wecomUserId, employeeNo}]
    mentors: text('mentors'), // JSON 数组：[{name, wecomUserId, employeeNo, type}]
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    index('idx_role_person_wecom').on(t.wecomUserId),
    index('idx_role_person_employee').on(t.employeeNo),
    index('idx_role_person_role').on(t.role),
  ]
);

export type RolePersonMap = typeof rolePersonMap.$inferSelect;
export type NewRolePersonMap = typeof rolePersonMap.$inferInsert;

// ─── Graph: 课程—节点关联（定时同步，课程总数不再是静态 9 门）────────────
// 由主机定时脚本 sync-graph-courses.py 按关键词把 blog 已发布课程关联到图谱
// 节点；一人一行，主键 id = `link:<nodeId>:<courseBid>`；静态 TREE 链接仍在
// graph.json 里，本表只存动态关联，页面合并两边去重后展示。
export const graphCourseLink = table(
  'graph_course_link',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id').notNull(),
    courseBid: text('course_bid').notNull(),
    score: integer('score').notNull().default(0),
    source: text('source').notNull().default('auto'),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    index('idx_graph_link_node').on(t.nodeId),
    index('idx_graph_link_course').on(t.courseBid),
  ]
);

export type GraphCourseLink = typeof graphCourseLink.$inferSelect;
export type NewGraphCourseLink = typeof graphCourseLink.$inferInsert;

// ─── Cuotiben (错题本) ───────────────────────────────────────────────────────

export const cuotibenCard = table(
  'cuotiben_card',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    src: text('src').notNull().default(''),
    subject: text('subject').notNull().default(''),
    tag: text('tag').notNull().default(''),
    kind: text('kind').notNull().default(''),
    question: text('question').notNull(),
    myAnswer: text('my_answer').notNull().default(''),
    answer: text('answer').notNull().default(''),
    principle: text('principle').notNull().default(''),
    note: text('note').notNull().default(''),
    diagram: text('diagram'),
    mastered: boolean('mastered').default(false).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('idx_cuotiben_card_user').on(t.userId),
    index('idx_cuotiben_card_user_subject').on(t.userId, t.subject),
  ]
);

export const cuotibenQaLog = table(
  'cuotiben_qa_log',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    cardId: text('card_id').notNull(),
    kind: text('kind').notNull(),
    ok: boolean('ok').default(false).notNull(),
    skip: boolean('skip').default(false).notNull(),
    ts: timestamp('ts').notNull(),
  },
  (t) => [
    index('idx_cuotiben_qa_user_ts').on(t.userId, t.ts),
    index('idx_cuotiben_qa_card').on(t.cardId),
  ]
);

export const cuotibenSrs = table(
  'cuotiben_srs',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    cardId: text('card_id').notNull(),
    ivl: integer('ivl').notNull().default(1),
    ease: integer('ease').notNull().default(250),
    due: timestamp('due').notNull(),
    reps: integer('reps').notNull().default(0),
  },
  (t) => [index('idx_cuotiben_srs_user_due').on(t.userId, t.due)]
);

// AI 生成的练习题（基于错题），掌握情况独立跟踪
export const cuotibenPractice = table(
  'cuotiben_practice',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    cardId: text('card_id').notNull(),
    subject: text('subject').notNull().default(''),
    tag: text('tag').notNull().default(''),
    question: text('question').notNull(),
    answer: text('answer').notNull().default(''),
    principle: text('principle').notNull().default(''),
    mastered: boolean('mastered').default(false).notNull(),
    attempts: integer('attempts').notNull().default(0),
    correctCount: integer('correct_count').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_cuotiben_practice_user').on(t.userId),
    index('idx_cuotiben_practice_card').on(t.cardId),
  ]
);

export type CuotibenCard = typeof cuotibenCard.$inferSelect;
export type NewCuotibenCard = typeof cuotibenCard.$inferInsert;
export type CuotibenQaLog = typeof cuotibenQaLog.$inferSelect;
export type CuotibenSrs = typeof cuotibenSrs.$inferSelect;
