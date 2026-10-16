import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileText, Upload } from 'lucide-react';

import { apiGet, apiPost } from '@/lib/api-client';

interface HtmlItem {
  key: string;
  size: number;
  uploaded: string;
  url: string;
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

  const items = data?.items || [];

  return (
    <div className="bg-card mt-16 rounded-lg border p-6">
      <h2 className="text-foreground mb-2 text-lg font-semibold tracking-tight">
        HTML 发布
      </h2>
      <p className="text-muted-foreground mb-4 text-sm leading-7">
        上传已包含 CSS 的单文件 HTML（如 tools/publish.py 生成的），保存到
        R2，通过链接分享。渲染风格与博客 MDX 文章统一。
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

      {items.length > 0 && (
        <div className="mt-6">
          <h3 className="text-foreground mb-3 text-base font-semibold">
            已发布 ({items.length})
          </h3>
          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={item.key}
                className="border-border flex items-center justify-between rounded-lg border p-3"
              >
                <div className="flex items-center gap-2">
                  <FileText className="text-muted-foreground size-4" />
                  <span className="text-foreground text-sm">
                    {item.key.replace('html/', '')}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {(item.size / 1024).toFixed(1)}KB
                  </span>
                </div>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
                >
                  查看 <ExternalLink className="size-3" />
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
