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
    <div className="mt-16 rounded-lg border p-6">
      <h2 className="mb-4 text-xl font-bold">HTML 发布</h2>
      <p className="text-muted-foreground mb-4 text-sm">
        上传已包含 CSS 的单文件 HTML（如 tools/publish.py 生成的），保存到
        R2，通过链接分享。
      </p>

      <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-blue-500 px-4 py-2 text-white hover:bg-blue-600">
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
          <h3 className="mb-3 font-semibold">已发布 ({items.length})</h3>
          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={item.key}
                className="flex items-center justify-between rounded border p-3"
              >
                <div className="flex items-center gap-2">
                  <FileText className="size-4 text-gray-500" />
                  <span className="text-sm">
                    {item.key.replace('html/', '')}
                  </span>
                  <span className="text-xs text-gray-400">
                    {(item.size / 1024).toFixed(1)}KB
                  </span>
                </div>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-blue-500 hover:underline"
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
