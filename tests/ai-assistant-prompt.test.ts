import assert from 'node:assert/strict';
import { test } from 'node:test';

// 对话 system prompt 是纯函数：不读数据库、不读配置、不联网。
const { chatSystemPrompt } = await import('@/modules/ai-assistant/chat');

const baseInput = {
  query: '帮我把这份培训大纲做成 PPT',
  history: [],
  catalog: [],
  docSections: [],
  tools: {
    searchCourses: async () => [],
    getCourse: async () => ({ error: 'not found' }),
    listCategories: async () => [],
    getMyStatus: async () => [],
    searchDocs: async () => [],
  },
  resolveCourse: async () => null,
  docSectionUrl: () => '',
  baseUrl: '',
  apiKey: '',
} as const;

test('system prompt：用户要 PPT 时指引点「生成 PPT」按钮，而不是拒绝', () => {
  const prompt = chatSystemPrompt(baseInput as any);
  assert.match(prompt, /生成 PPT/);
  assert.match(prompt, /按钮/);
  // 明确不说“做不了 / 没有文件”，而是告诉用户去点按钮。
  assert.match(prompt, /不要说做不了/);
  // 旧的拒绝口径（“无法生成/存储 .pptx”）不应出现在 prompt 里。
  assert.doesNotMatch(prompt, /无法生成/);
  assert.doesNotMatch(prompt, /无法存储/);
});

test('system prompt：PPT 指引不依赖知识库工具（无 searchKb 时也有）', () => {
  const prompt = chatSystemPrompt(baseInput as any);
  assert.match(prompt, /生成 PPT/);
});
