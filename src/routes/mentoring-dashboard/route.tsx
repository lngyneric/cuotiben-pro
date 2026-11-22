import { createFileRoute, Outlet } from '@tanstack/react-router';

// 学分制带教 Dashboard —— 布局路由（只渲染 Outlet）。
//
// 总表在 index.tsx（/mentoring-dashboard），个人页在 $recordId.tsx
// （/mentoring-dashboard/:recordId）。父级若直接渲染总表，子路由
// 挂不上（2026-11-22 实测：个人页地址与标题变了，正文仍是总表）。
// 此处只挂 Outlet，与 ai-assistant 的 route.tsx 同一模式。
export const Route = createFileRoute('/mentoring-dashboard')({
  component: () => <Outlet />,
});
