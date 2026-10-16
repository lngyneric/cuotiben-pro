import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Upload } from 'lucide-react';

import { apiGet } from '@/lib/api-client';

interface HtmlItem {
  key: string;
  title: string;
  description: string;
  size: number;
  uploaded: string;
  url: string;
}

// MDX 风格的卡片列表（替代原来的 MDX posts）
export function HtmlList({ locale }: { locale: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['blog-html-list'],
    queryFn: () => apiGet<{ items: HtmlItem[] }>('/api/blog/html'),
  });

  const items = data?.items || [];

  if (isLoading) {
    return <p className="text-muted-foreground text-center">加载中...</p>;
  }

  if (items.length === 0) {
    return (
      <p className="text-muted-foreground text-center">
        暂无文章，请在下方上传 HTML
      </p>
    );
  }

  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <a
          key={item.key}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-card border-border group rounded-lg border p-6 transition-shadow hover:shadow-lg"
        >
          <h3 className="text-foreground mb-2 text-lg font-semibold tracking-tight group-hover:underline">
            {item.title}
          </h3>
          {item.description && (
            <p className="text-muted-foreground mb-4 line-clamp-2 text-sm leading-7">
              {item.description}
            </p>
          )}
          <div className="text-muted-foreground flex items-center justify-between text-xs">
            <span>
              {new Date(item.uploaded).toLocaleDateString(
                locale === 'zh' ? 'zh-CN' : 'en-US'
              )}
            </span>
            <span className="text-primary inline-flex items-center gap-1 font-medium">
              阅读 <ExternalLink className="size-3" />
            </span>
          </div>
        </a>
      ))}
    </div>
  );
}

export function HtmlUpload() {
  const [uploading, setUploading] = useState(false);
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['blog-html-list'],
    queryFn: () => apiGet<{ items: HtmlItem[] }>('/api/blog/html'),
  });

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);

      // FormData 需要用原生 fetch（api-client 是 JSON）
      const res = await fetch('/api/blog/html', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      const json = await res.json();
      if (json.code !== 0) throw new Error(json.message);

      queryClient.invalidateQueries({ queryKey: ['blog-html-list'] });
      alert('上传成功！');
    } catch (err: any) {
      alert('上传失败: ' + err.message);
    }
    setUploading(false);
    e.target.value = '';
  };

  return (
    <div className="bg-card mt-16 rounded-lg border p-6">
      <h2 className="text-foreground mb-2 text-lg font-semibold tracking-tight">
        HTML 发布
      </h2>
      <p className="text-muted-foreground mb-4 text-sm leading-7">
        上传已包含 CSS 的单文件 HTML（如 tools/publish.py 生成的），保存到
        R2，通过链接分享。渲染风格与博客文章统一。
      </p>

      <label className="bg-primary text-primary-foreground inline-flex cursor-pointer items-center gap-2 rounded-full px-6 py-2.5 text-sm font-medium hover:opacity-90">
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
  );
}
