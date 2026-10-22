import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Calendar,
  ChevronRight,
  ExternalLink,
  Trash2,
  Upload,
} from 'lucide-react';

import { apiDelete, apiGet, apiPatch } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface HtmlItem {
  key: string;
  title: string;
  description: string;
  category: string;
  size: number;
  uploaded: string;
  url: string;
}

type ViewMode = 'category' | 'timeline';

// 左边：分类+时间轴列表
export function HtmlList({
  locale,
  selected,
  onSelect,
}: {
  locale: string;
  selected: HtmlItem | null;
  onSelect: (item: HtmlItem) => void;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>('category');
  const [activeCategory, setActiveCategory] = useState<string>('全部');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['blog-html-list'],
    queryFn: () => apiGet<{ items: HtmlItem[] }>('/api/blog/html'),
  });

  const items = data?.items || [];

  const categories = useMemo(() => {
    const cats = new Set(items.map((i) => i.category || '未分类'));
    return ['全部', ...Array.from(cats)];
  }, [items]);

  const filtered = useMemo(() => {
    if (activeCategory === '全部') return items;
    return items.filter((i) => (i.category || '未分类') === activeCategory);
  }, [items, activeCategory]);

  // 按分类分组
  const byCategory = useMemo(() => {
    const map = new Map<string, HtmlItem[]>();
    for (const item of filtered) {
      const cat = item.category || '未分类';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(item);
    }
    return Array.from(map.entries());
  }, [filtered]);

  // 按时间轴分组（年月）
  const byTimeline = useMemo(() => {
    const map = new Map<string, HtmlItem[]>();
    for (const item of filtered) {
      const d = new Date(item.uploaded);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);

  const fmtDate = (s: string) =>
    new Date(s).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
      month: 'short',
      day: 'numeric',
    });

  const renderItem = (item: HtmlItem) => (
    <div
      key={item.key}
      className={cn(
        'w-full rounded-lg border p-3 transition-colors',
        selected?.key === item.key
          ? 'border-primary bg-primary/5'
          : 'border-border hover:border-primary/50'
      )}
    >
      <button onClick={() => onSelect(item)} className="w-full text-left">
        <div className="text-foreground text-sm leading-6 font-medium">
          {item.title}
        </div>
        {item.description && (
          <div className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-5">
            {item.description}
          </div>
        )}
      </button>
      <div className="text-muted-foreground mt-2 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <Calendar className="size-3" />
          {fmtDate(item.uploaded)}
          <select
            value={item.category || '未分类'}
            onChange={async (e) => {
              const category = e.target.value;
              try {
                await apiPatch('/api/blog/html', { key: item.key, category });
                queryClient.invalidateQueries({
                  queryKey: ['blog-html-list'],
                });
              } catch (err: any) {
                alert('改分类失败: ' + err.message);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="bg-muted rounded border-0 px-1.5 py-0.5 text-xs"
            title="点击修改分类"
          >
            {['G8学习', '错题解析', '工具', '未分类'].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={async (e) => {
            e.stopPropagation();
            if (!confirm(`删除「${item.title}」？`)) return;
            try {
              await apiDelete(
                `/api/blog/html?key=${encodeURIComponent(item.key)}`
              );
              queryClient.invalidateQueries({ queryKey: ['blog-html-list'] });
            } catch (err: any) {
              alert('删除失败: ' + err.message);
            }
          }}
          className="text-muted-foreground hover:text-red-500"
          title="删除"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );

  if (isLoading) {
    return <p className="text-muted-foreground p-4 text-center">加载中...</p>;
  }

  return (
    <div className="flex h-full flex-col">
      {/* 视图切换 */}
      <div className="mb-3 flex gap-2">
        <button
          onClick={() => setViewMode('category')}
          className={cn(
            'rounded-full px-3 py-1 text-xs font-medium',
            viewMode === 'category'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground'
          )}
        >
          按分类
        </button>
        <button
          onClick={() => setViewMode('timeline')}
          className={cn(
            'rounded-full px-3 py-1 text-xs font-medium',
            viewMode === 'timeline'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground'
          )}
        >
          时间轴
        </button>
      </div>

      {/* 分类筛选 */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs',
              activeCategory === cat
                ? 'border-primary text-primary font-medium'
                : 'border-border text-muted-foreground'
            )}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* 列表 */}
      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            暂无文章，请在下方上传
          </p>
        ) : viewMode === 'category' ? (
          byCategory.map(([cat, list]) => (
            <div key={cat}>
              <div className="text-muted-foreground mb-2 flex items-center gap-1 text-xs font-medium">
                <ChevronRight className="size-3" />
                {cat} ({list.length})
              </div>
              <div className="space-y-2">{list.map(renderItem)}</div>
            </div>
          ))
        ) : (
          byTimeline.map(([month, list]) => (
            <div key={month}>
              <div className="text-muted-foreground mb-2 text-xs font-medium">
                {month} ({list.length})
              </div>
              <div className="space-y-2">{list.map(renderItem)}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// 上传组件
export function HtmlUpload() {
  const [uploading, setUploading] = useState(false);
  const [category, setCategory] = useState('');
  const queryClient = useQueryClient();

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (category.trim()) formData.append('category', category.trim());

      const res = await fetch('/api/blog/html', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      const json = await res.json();
      if (json.code !== 0) throw new Error(json.message);

      queryClient.invalidateQueries({ queryKey: ['blog-html-list'] });
      setCategory('');
      alert('上传成功！');
    } catch (err: any) {
      alert('上传失败: ' + err.message);
    }
    setUploading(false);
    e.target.value = '';
  };

  return (
    <div className="bg-card rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="分类（留空自动识别）"
          className="border-border bg-background rounded-full border px-3 py-1.5 text-sm"
        />
        <label className="bg-primary text-primary-foreground inline-flex cursor-pointer items-center gap-2 rounded-full px-5 py-1.5 text-sm font-medium hover:opacity-90">
          <Upload className="size-4" />
          {uploading ? '上传中...' : '上传 HTML'}
          <input
            type="file"
            accept=".html,text/html"
            onChange={handleUpload}
            disabled={uploading}
            className="hidden"
          />
        </label>
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        上传 tools/publish.py 生成的单文件
        HTML；分类留空时按标题/内容自动识别，也可以上传后在列表里直接改
      </p>
    </div>
  );
}
