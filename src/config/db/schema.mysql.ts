/**
 * MySQL schema definitions.
 *
 * This is the MySQL dialect of the database schema.
 * To use: set DATABASE_PROVIDER=mysql in .env.local,
 * then copy this file's content into schema.ts.
 */

import {
  boolean,
  index,
  int,
  longtext,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

const table = mysqlTable;

const varchar191 = (name: string) => varchar(name, { length: 191 });

// ─── Auth ────────────────────────────────────────────────────────────────────

export const user = table(
  'user',
  {
    id: varchar191('id').primaryKey(),
    name: varchar191('name').notNull(),
    email: varchar191('email').notNull().unique(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    image: text('image'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    utmSource: varchar('utm_source', { length: 100 }).notNull().default(''),
    ip: varchar('ip', { length: 45 }).notNull().default(''),
    locale: varchar('locale', { length: 20 }).notNull().default(''),
    utmCampaign: varchar('utm_campaign', { length: 100 }).notNull().default(''),
    utmTerm: varchar('utm_term', { length: 100 }).notNull().default(''),
    utmMedium: varchar('utm_medium', { length: 100 }).notNull().default(''),
    utmContent: varchar('utm_content', { length: 100 }).notNull().default(''),
    referrer: varchar('referrer', { length: 500 }).notNull().default(''),
    country: varchar('country', { length: 10 }).notNull().default(''),
    // 'user' = a person; 'api' = an agent/service account (no login, keys only).
    type: varchar('type', { length: 20 }).notNull().default('user'),
  },
  (table) => [
    index('idx_user_name').on(table.name),
    index('idx_user_created_at').on(table.createdAt),
  ]
);

export const session = table(
  'session',
  {
    id: varchar191('id').primaryKey(),
    expiresAt: timestamp('expires_at').notNull(),
    token: varchar191('token').notNull().unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    userId: varchar191('user_id')
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
    id: varchar191('id').primaryKey(),
    accountId: varchar191('account_id').notNull(),
    providerId: varchar('provider_id', { length: 50 }).notNull(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: varchar('scope', { length: 255 }),
    password: text('password'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    index('idx_account_user_id').on(table.userId),
    index('idx_account_provider_account').on(table.providerId, table.accountId),
  ]
);

export const verification = table(
  'verification',
  {
    id: varchar191('id').primaryKey(),
    identifier: varchar191('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => [index('idx_verification_identifier').on(table.identifier)]
);

// ─── Content ─────────────────────────────────────────────────────────────────

export const config = table('config', {
  name: varchar191('name').unique().notNull(),
  value: text('value'),
});

export const taxonomy = table(
  'taxonomy',
  {
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    parentId: varchar191('parent_id'),
    slug: varchar191('slug').unique().notNull(),
    type: varchar('type', { length: 50 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    image: text('image'),
    icon: varchar191('icon'),
    status: varchar('status', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp('deleted_at'),
    sort: int('sort').default(0).notNull(),
  },
  (table) => [index('idx_taxonomy_type_status').on(table.type, table.status)]
);

export const post = table(
  'post',
  {
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    parentId: varchar191('parent_id'),
    slug: varchar191('slug').unique().notNull(),
    type: varchar('type', { length: 50 }).notNull(),
    title: varchar('title', { length: 255 }),
    description: text('description'),
    image: text('image'),
    content: longtext('content'),
    categories: text('categories'),
    tags: text('tags'),
    authorName: varchar191('author_name'),
    authorImage: text('author_image'),
    status: varchar('status', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp('deleted_at'),
    sort: int('sort').default(0).notNull(),
  },
  (table) => [index('idx_post_type_status').on(table.type, table.status)]
);

// ─── Business ────────────────────────────────────────────────────────────────

export const order = table(
  'order',
  {
    id: varchar191('id').primaryKey(),
    orderNo: varchar191('order_no').unique().notNull(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userEmail: varchar191('user_email'),
    status: varchar('status', { length: 50 }).notNull(),
    amount: int('amount').notNull(),
    currency: varchar('currency', { length: 10 }).notNull(),
    productId: varchar191('product_id'),
    paymentType: varchar('payment_type', { length: 50 }),
    paymentInterval: varchar('payment_interval', { length: 50 }),
    paymentProvider: varchar('payment_provider', { length: 50 }).notNull(),
    paymentSessionId: varchar191('payment_session_id'),
    checkoutInfo: text('checkout_info').notNull(),
    checkoutResult: text('checkout_result'),
    paymentResult: text('payment_result'),
    discountCode: varchar191('discount_code'),
    discountAmount: int('discount_amount'),
    discountCurrency: varchar('discount_currency', { length: 10 }),
    paymentEmail: varchar191('payment_email'),
    paymentAmount: int('payment_amount'),
    paymentCurrency: varchar('payment_currency', { length: 10 }),
    paidAt: timestamp('paid_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp('deleted_at'),
    description: text('description'),
    productName: varchar('product_name', { length: 255 }),
    subscriptionId: varchar191('subscription_id'),
    subscriptionResult: text('subscription_result'),
    checkoutUrl: text('checkout_url'),
    callbackUrl: text('callback_url'),
    creditsAmount: int('credits_amount'),
    creditsValidDays: int('credits_valid_days'),
    planName: varchar191('plan_name'),
    paymentProductId: varchar191('payment_product_id'),
    invoiceId: varchar191('invoice_id'),
    invoiceUrl: text('invoice_url'),
    subscriptionNo: varchar191('subscription_no'),
    transactionId: varchar191('transaction_id'),
    paymentUserName: varchar191('payment_user_name'),
    paymentUserId: varchar191('payment_user_id'),
    refundAmount: int('refund_amount'),
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
    id: varchar191('id').primaryKey(),
    subscriptionNo: varchar191('subscription_no').unique().notNull(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userEmail: varchar191('user_email'),
    status: varchar('status', { length: 50 }).notNull(),
    paymentProvider: varchar('payment_provider', { length: 50 }).notNull(),
    subscriptionId: varchar191('subscription_id').notNull(),
    subscriptionResult: text('subscription_result'),
    productId: varchar191('product_id'),
    description: text('description'),
    amount: int('amount'),
    currency: varchar('currency', { length: 10 }),
    interval: varchar('interval', { length: 50 }),
    intervalCount: int('interval_count'),
    trialPeriodDays: int('trial_period_days'),
    currentPeriodStart: timestamp('current_period_start'),
    currentPeriodEnd: timestamp('current_period_end'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp('deleted_at'),
    planName: varchar191('plan_name'),
    billingUrl: text('billing_url'),
    productName: varchar('product_name', { length: 255 }),
    creditsAmount: int('credits_amount'),
    creditsValidDays: int('credits_valid_days'),
    paymentProductId: varchar191('payment_product_id'),
    paymentUserId: varchar191('payment_user_id'),
    canceledAt: timestamp('canceled_at'),
    canceledEndAt: timestamp('canceled_end_at'),
    canceledReason: text('canceled_reason'),
    canceledReasonType: varchar('canceled_reason_type', { length: 50 }),
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
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userEmail: varchar191('user_email'),
    orderNo: varchar191('order_no'),
    subscriptionNo: varchar191('subscription_no'),
    transactionNo: varchar191('transaction_no').unique().notNull(),
    transactionType: varchar('transaction_type', { length: 50 }).notNull(),
    transactionScene: varchar('transaction_scene', { length: 50 }),
    credits: int('credits').notNull(),
    remainingCredits: int('remaining_credits').notNull().default(0),
    description: text('description'),
    expiresAt: timestamp('expires_at'),
    status: varchar('status', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
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
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    keyHash: varchar191('key_hash').notNull(),
    keyPrefix: varchar191('key_prefix').notNull(),
    key: varchar191('key'),
    title: varchar191('title').notNull(),
    status: varchar('status', { length: 50 }).notNull(),
    lastUsedAt: timestamp('last_used_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp('deleted_at'),
    // 'user' = product API key (sk_); 'admin' = admin/agent API key (sa_admin_).
    type: varchar('type', { length: 20 }).notNull().default('user'),
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
    id: varchar191('id').primaryKey(),
    name: varchar191('name').notNull().unique(),
    title: varchar191('title').notNull(),
    description: text('description'),
    status: varchar('status', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    sort: int('sort').default(0).notNull(),
  },
  (table) => [index('idx_role_status').on(table.status)]
);

export const permission = table(
  'permission',
  {
    id: varchar191('id').primaryKey(),
    code: varchar191('code').notNull().unique(),
    resource: varchar('resource', { length: 50 }).notNull(),
    action: varchar('action', { length: 50 }).notNull(),
    title: varchar191('title').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    index('idx_permission_resource_action').on(table.resource, table.action),
  ]
);

export const rolePermission = table(
  'role_permission',
  {
    id: varchar191('id').primaryKey(),
    roleId: varchar191('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
    permissionId: varchar191('permission_id')
      .notNull()
      .references(() => permission.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
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
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    roleId: varchar191('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
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
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    mediaType: varchar('media_type', { length: 50 }).notNull(),
    provider: varchar('provider', { length: 50 }).notNull(),
    model: varchar191('model').notNull(),
    prompt: longtext('prompt').notNull(),
    options: longtext('options'),
    status: varchar('status', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp('deleted_at'),
    taskId: varchar191('task_id'),
    taskInfo: longtext('task_info'),
    taskResult: longtext('task_result'),
    costCredits: int('cost_credits').notNull().default(0),
    scene: varchar('scene', { length: 100 }).notNull().default(''),
    creditId: varchar191('credit_id'),
  },
  (table) => [
    index('idx_ai_task_user_media_type').on(table.userId, table.mediaType),
    index('idx_ai_task_media_type_status').on(table.mediaType, table.status),
  ]
);

export const chat = table(
  'chat',
  {
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    model: varchar191('model').notNull(),
    provider: varchar('provider', { length: 50 }).notNull(),
    title: varchar('title', { length: 255 }).notNull().default(''),
    parts: longtext('parts').notNull(),
    metadata: longtext('metadata'),
    content: longtext('content'),
  },
  (table) => [index('idx_chat_user_status').on(table.userId, table.status)]
);

export const chatMessage = table(
  'chat_message',
  {
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    chatId: varchar191('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    role: varchar('role', { length: 50 }).notNull(),
    parts: longtext('parts').notNull(),
    metadata: longtext('metadata'),
    model: varchar191('model').notNull(),
    provider: varchar('provider', { length: 50 }).notNull(),
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
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id),
    title: varchar('title', { length: 255 }).notNull(),
    status: varchar('status', { length: 50 }).notNull().default('open'), // open | replied | closed
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    index('idx_ticket_user').on(t.userId),
    index('idx_ticket_status').on(t.status),
  ]
);

export const ticketMessage = table(
  'ticket_message',
  {
    id: varchar191('id').primaryKey(),
    ticketId: varchar191('ticket_id')
      .notNull()
      .references(() => ticket.id),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id),
    role: varchar('role', { length: 50 }).notNull().default('user'), // user | admin
    content: longtext('content').notNull(),
    attachments: longtext('attachments').notNull(), // JSON array of image URLs (default [] set by service)
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

// Agent administration: durable execution journal. Agents are `user.type = 'api'`
// accounts whose credentials are `apikey.type = 'admin'` rows; tokenId → apikey.id.
export const adminExecution = table(
  'admin_execution',
  {
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id').notNull(),
    tokenId: varchar191('token_id'),
    operation: varchar191('operation').notNull(),
    inputHash: varchar191('input_hash').notNull(),
    targetId: varchar191('target_id'),
    status: varchar191('status').notNull(),
    response: longtext('response'),
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
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: varchar191('kind').notNull(),
    detail: text('detail'),
    source: varchar191('source').notNull(), // server | client
    createdAt: timestamp('created_at', { fsp: 3 }).notNull(),
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
    id: varchar191('id').primaryKey(),
    employeeNo: varchar191('employee_no'),
    wecomUserId: varchar191('wecom_user_id'),
    wikiUserId: varchar191('wiki_user_id'),
    aishifuUserBid: varchar191('aishifu_user_bid'),
    name: varchar191('name').notNull(),
    department: varchar191('department'),
    positionName: varchar191('position_name'),
    mentorLeadId: varchar191('mentor_lead_id'),
    mentorLeadName: varchar191('mentor_lead_name'),
    mentors: text('mentors'), // JSON: {lead, keyAccount, exempt, departmentHead} with WeCom ids + names
    planType: varchar191('plan_type'),
    planStartDate: varchar191('plan_start_date'), // ISO date
    planEndDate: varchar191('plan_end_date'), // ISO date
    expectedDate: varchar191('expected_date'), // ISO date
    plan: text('plan'), // JSON: {nodes: [{node, expected}]}
    actual: text('actual'), // JSON: {status, result, nodeRatings, confirmations, scores, courses, lastActivityAt}
    flags: text('flags'), // JSON array: overdue | pending_confirm | no_course_activity | no_wiki_account | unresolved_identity
    planVersion: varchar191('plan_version').notNull().default('v1'),
    sourceWatermarks: text('source_watermarks'), // JSON: {smartsheetEditedAt, aishifuMaxUpdatedAt, wikiMaxEventAt}
    computedAt: timestamp('computed_at', { fsp: 3 }).notNull(),
    updatedAt: timestamp('updated_at', { fsp: 3 })
      .defaultNow()
      .onUpdateNow()
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
    id: varchar191('id').primaryKey(),
    name: varchar191('name').notNull(),
    employeeNo: varchar191('employee_no'),
    wecomUserId: varchar191('wecom_user_id'),
    role: varchar191('role').notNull(), // 学员 | 导师 | 两者都是
    mentorTypes: text('mentor_types'), // JSON 数组：带教负责人 / 大客户带教 / 生免带教
    mentees: text('mentees'), // JSON 数组：[{name, wecomUserId, employeeNo}]
    mentors: text('mentors'), // JSON 数组：[{name, wecomUserId, employeeNo, type}]
    updatedAt: timestamp('updated_at', { fsp: 3 })
      .defaultNow()
      .onUpdateNow()
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
    id: varchar191('id').primaryKey(),
    nodeId: varchar191('node_id').notNull(),
    courseBid: varchar191('course_bid').notNull(),
    score: integer('score').notNull().default(0),
    source: varchar191('source').notNull().default('auto'),
    updatedAt: timestamp('updated_at', { fsp: 3 })
      .defaultNow()
      .onUpdateNow()
      .notNull(),
  },
  (t) => [
    index('idx_graph_link_node').on(t.nodeId),
    index('idx_graph_link_course').on(t.courseBid),
  ]
);

export type GraphCourseLink = typeof graphCourseLink.$inferSelect;
export type NewGraphCourseLink = typeof graphCourseLink.$inferInsert;

// ─── Growth Path (成长路径) ─────────────────────────────────────────────────
// Auto-matched video courses for growth nodes (title matching, see
// sync-growth-courses.py). Same shape as graphCourseLink.
export const growthCourseLink = table(
  'growth_course_link',
  {
    id: varchar191('id').primaryKey(),
    nodeId: varchar191('node_id').notNull(),
    courseBid: varchar191('course_bid').notNull(),
    score: integer('score').notNull().default(0),
    source: varchar191('source').notNull().default('auto-title'),
    updatedAt: timestamp('updated_at', { fsp: 3 })
      .defaultNow()
      .onUpdateNow()
      .notNull(),
  },
  (t) => [
    index('idx_growth_link_node').on(t.nodeId),
    index('idx_growth_link_course').on(t.courseBid),
  ]
);

export type GrowthCourseLink = typeof growthCourseLink.$inferSelect;
export type NewGrowthCourseLink = typeof growthCourseLink.$inferInsert;

// ─── Presentations (PPT 生成任务) ───────────────────────────────────────────
// wiki agent 的 PPT 生成任务（Presenton）。一行一个任务；归属按调用方身份
// 登记（ownerUserId + ownerTokenId），查询与下载只放行属主本人——Presenton
// 侧是共用管理员账号，所有 deck 在其名下互见，绝不能把原生编辑地址或别人
// 的文件返回给调用方。任务状态由 presentations_get 轮询 Presenton 后更新，
// wiki 不跑后台 worker。
export const presentationJob = table(
  'presentation_job',
  {
    id: varchar191('id').primaryKey(),
    ownerUserId: varchar191('owner_user_id').notNull(),
    ownerTokenId: varchar191('owner_token_id'),
    presentonId: varchar191('presenton_id'),
    presentonTaskId: varchar191('presenton_task_id'),
    status: varchar191('status').notNull().default('queued'), // queued | generating | completed | failed
    title: varchar191('title'),
    slideCount: int('slide_count'),
    exportPath: text('export_path'), // Presenton 侧导出路径（相对路径或绝对 URL），只在服务端用，绝不返回给调用方
    error: text('error'),
    errorCode: varchar191('error_code'), // llm_quota_exceeded 等，见 presentations/service.ts
    // 阶段 0 地基（presentations/layouts.ts、element-index.ts、job-meta.ts）：
    // themeVersion 生成时写入；elementIndex 下载盖章时写入；另外两列由
    // 阶段 1（内容源 + outline）写入，阶段 0 只定义结构、不写值。
    themeVersion: text('theme_version'),
    layoutAssignments: text('layout_assignments'), // JSON LayoutAssignment[]
    elementIndex: text('element_index'), // JSON PptxElementIndex
    pageSourceRefs: text('page_source_refs'), // JSON PageSourceRef[]
    // 阶段 1：图片映射（JSON ImageAssignment[]）与下发提示长度（超时日志用）。
    imageAssignments: text('image_assignments'),
    // 阶段 3：图表落图（JSON ChartAssignment[]，生成时写入、完成时落图）。
    chartAssignments: text('chart_assignments'),
    // 导航＋意图优化：生成校验元数据（JSON GenerationMeta：期望页数、
    // 标题页开关、已重试次数、重跑用的请求快照），生成时写入。
    generationMeta: text('generation_meta'),
    promptChars: int('prompt_chars'),
    createdAt: timestamp('created_at', { fsp: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { fsp: 3 })
      .defaultNow()
      .onUpdateNow()
      .notNull(),
  },
  (t) => [
    index('idx_presentation_job_owner').on(t.ownerUserId),
    index('idx_presentation_job_status').on(t.status),
  ]
);

export type PresentationJob = typeof presentationJob.$inferSelect;
export type NewPresentationJob = typeof presentationJob.$inferInsert;

// ─── Presentations 阶段 1：内容源 / 页面划分草稿 / 图片库 ──────────────────
// 三张表只存元数据与抽取文本（不存二进制）：图片本体走 wiki 现有文件存储
// （R2 或 public/uploads，见 presentations/images.ts 的核实记录）；来源
// 抽取文本按附件口径截断上限（单文件 8000 字、合计 16000 字，超限拒绝不截断）。
export const presentationSource = table(
  'presentation_source',
  {
    id: varchar191('id').primaryKey(),
    ownerUserId: varchar191('owner_user_id').notNull(),
    ownerTokenId: varchar191('owner_token_id'),
    kind: varchar191('kind').notNull(), // upload_text | reference_ppt | wiki_kb
    name: varchar191('name').notNull().default(''),
    status: varchar191('status').notNull().default('ready'), // ready | empty
    extractChars: int('extract_chars').notNull().default(0),
    pageCount: int('page_count'),
    text: text('text').notNull().default(''),
    meta: text('meta'), // JSON：参考 PPT 的逐页标题/主题色、知识库的条目清单
    createdAt: timestamp('created_at', { fsp: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { fsp: 3 })
      .defaultNow()
      .onUpdateNow()
      .notNull(),
  },
  (t) => [index('idx_presentation_source_owner').on(t.ownerUserId)]
);

export type PresentationSource = typeof presentationSource.$inferSelect;
export type NewPresentationSource = typeof presentationSource.$inferInsert;

export const presentationOutline = table(
  'presentation_outline',
  {
    id: varchar191('id').primaryKey(),
    ownerUserId: varchar191('owner_user_id').notNull(),
    ownerTokenId: varchar191('owner_token_id'),
    sourceIds: text('source_ids').notNull().default('[]'), // JSON string[]
    pages: text('pages').notNull().default('[]'), // JSON OutlinePage[]
    status: varchar191('status').notNull().default('draft'), // draft | confirmed
    version: int('version').notNull().default(1),
    createdAt: timestamp('created_at', { fsp: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { fsp: 3 })
      .defaultNow()
      .onUpdateNow()
      .notNull(),
  },
  (t) => [index('idx_presentation_outline_owner').on(t.ownerUserId)]
);

export type PresentationOutline = typeof presentationOutline.$inferSelect;
export type NewPresentationOutline = typeof presentationOutline.$inferInsert;

export const presentationImage = table(
  'presentation_image',
  {
    id: varchar191('id').primaryKey(),
    ownerUserId: varchar191('owner_user_id').notNull(),
    ownerTokenId: varchar191('owner_token_id'),
    sourceType: varchar191('source_type').notNull(), // wiki_blog | wiki_html | upload | paste
    sourceRef: text('source_ref').notNull().default(''),
    fileName: varchar191('file_name').notNull().default(''),
    tags: text('tags').notNull().default(''),
    width: int('width'),
    height: int('height'),
    fileSize: int('file_size').notNull().default(0),
    storageKey: varchar191('storage_key').notNull().default(''),
    storageUrl: text('storage_url').notNull().default(''),
    createdAt: timestamp('created_at', { fsp: 3 }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { fsp: 3 }),
    updatedAt: timestamp('updated_at', { fsp: 3 })
      .defaultNow()
      .onUpdateNow()
      .notNull(),
  },
  (t) => [
    index('idx_presentation_image_owner').on(t.ownerUserId),
    index('idx_presentation_image_source').on(t.sourceType),
  ]
);

export type PresentationImage = typeof presentationImage.$inferSelect;
export type NewPresentationImage = typeof presentationImage.$inferInsert;

// ─── Presentations 阶段 2：单页编辑版本 ─────────────────────────────────────
// 一行一个已确认的编辑版本：整套 PPTX 字节存在版本文件里（与库文件同目
// 录的 ppt-edits/ 下，生产即 /app/data/ppt-edits，随命名卷持久化；
// public/uploads 不进卷、重建会丢，所以不放那里），表里只记元数据与
// 操作清单。version 从 1 递增；version 0 是 Presenton 原稿（不建行，
// 实时向 Presenton 取）。回退不删行：另起一版、内容复制目标版本，
// 审计链不断。下载始终取最大 version 的文件。
export const presentationPageVersion = table(
  'presentation_page_version',
  {
    id: varchar191('id').primaryKey(),
    jobId: varchar191('job_id').notNull(),
    version: int('version').notNull(),
    pageNo: int('page_no').notNull(),
    ops: text('ops').notNull().default('[]'), // JSON PageEditOp[]（回退行记 [{op:'revert',...}]）
    fileName: varchar191('file_name').notNull().default(''),
    createdAt: timestamp('created_at', { fsp: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { fsp: 3 })
      .defaultNow()
      .onUpdateNow()
      .notNull(),
  },
  (t) => [
    index('idx_presentation_page_version_job').on(t.jobId),
    // 同一任务的版本号唯一：并发两次编辑同时抢下一个版本时，后一次
    // 记行失败（文件已由 createPageVersion 清掉），不产生重号版本。
    uniqueIndex('uq_presentation_page_version_job_version').on(
      t.jobId,
      t.version
    ),
  ]
);

export type PresentationPageVersion =
  typeof presentationPageVersion.$inferSelect;
export type NewPresentationPageVersion =
  typeof presentationPageVersion.$inferInsert;
