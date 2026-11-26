import { createFileRoute, Outlet } from '@tanstack/react-router';

import { Link, usePathname } from '@/core/i18n/navigation';
import { m } from '@/paraglide/messages.js';
import { Footer } from '@/blocks/footer';
import { Header } from '@/blocks/header';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/ai-assistant')({
  component: AiAssistantLayout,
});

// 导航＋意图优化：对话与 PPT 共用一个空间，用页签切换（点 PPT 不再
// 新开标签页跳出空间）。nav 数组模式与 settings/admin 布局一致。
// 切换页签时聊天记录与 PPT 生成任务都在本机 localStorage 里，轮询
// 按 jobId 恢复，不重跑生成（见 -ppt-shared.ts）。
function AiAssistantLayout() {
  const pathname = usePathname();
  const navItems = [
    { href: '/ai-assistant', label: m['ai_assistant.tab_chat']() },
    { href: '/ai-assistant/ppt', label: m['ai_assistant.tab_ppt']() },
  ];
  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <Header />
      <div className="border-border border-b">
        <div className="mx-auto flex max-w-3xl gap-1 px-4">
          {navItems.map((item) => {
            const active =
              item.href === '/ai-assistant'
                ? pathname === '/ai-assistant'
                : pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'border-b-2 px-4 py-3 text-sm font-medium',
                  active
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </div>
      <main className="flex-1 px-4 py-8">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
