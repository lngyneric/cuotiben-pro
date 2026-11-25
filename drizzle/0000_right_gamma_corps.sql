-- 阶段 0（PPT 地基）：presentation_job 加 4 列留痕/主题字段。
--
-- 注意：这是本仓库第一份 migration，生产库早于迁移系统存在（此前 schema
-- 变更靠 db:push 直接同步）。本文件只含本次的增量 ALTER，不含全库建表，
-- 在已有库上可直接跑；全新库仍按 AGENTS.md 用 db:push 建表。
-- meta/0000_snapshot.json 是执行后的完整 schema 快照，供下次 generate 做 diff。
ALTER TABLE `presentation_job` ADD COLUMN `theme_version` text;--> statement-breakpoint
ALTER TABLE `presentation_job` ADD COLUMN `layout_assignments` text;--> statement-breakpoint
ALTER TABLE `presentation_job` ADD COLUMN `element_index` text;--> statement-breakpoint
ALTER TABLE `presentation_job` ADD COLUMN `page_source_refs` text;
