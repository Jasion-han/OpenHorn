import { expect, test } from 'bun:test';
import { TAVILY_API_KEY_SETTING, TAVILY_ENABLED_SETTING, buildSearchContext } from './searchService';

test('buildSearchContext prefers user tavily key over env key', async () => {
  const result = await buildSearchContext({
    route: 'web_search',
    prompt: '最近 AI 圈有什么新闻',
    userSettings: { [TAVILY_API_KEY_SETTING]: 'user-key' },
    envKey: 'env-key',
    fetchImpl: async (_input, init) => {
      expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer user-key');
      return new Response(JSON.stringify({ results: [] }));
    },
  });

  expect(result.status).toBe('offline');
  expect(result.label).toContain('暂不可用');
});

test('buildSearchContext uses env key when user key is absent', async () => {
  const result = await buildSearchContext({
    route: 'web_search',
    prompt: '最近 AI 圈有什么新闻',
    envKey: 'env-key',
    fetchImpl: async (_input, init) => {
      expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer env-key');
      return new Response(JSON.stringify({
        results: [
          { title: 'AI News', url: 'https://example.com/news', content: 'Latest updates' },
        ],
      }));
    },
  });

  expect(result.status).toBe('live');
  expect(result.provider).toBe('tavily');
  expect(result.citations).toHaveLength(1);
  expect(result.systemContext).toContain('https://example.com/news');
});

test('buildSearchContext returns offline when no key exists', async () => {
  const result = await buildSearchContext({
    route: 'research',
    prompt: '比较最近几家 AI 公司的发布和融资',
  });

  expect(result.status).toBe('offline');
  expect(result.label).toContain('未配置');
  expect(result.citations).toEqual([]);
});

test('buildSearchContext returns offline when disabled', async () => {
  const result = await buildSearchContext({
    route: 'web_search',
    prompt: '最近 AI 圈有什么新闻',
    envKey: 'env-key',
    userSettings: { [TAVILY_ENABLED_SETTING]: 'false' },
  });

  expect(result.status).toBe('offline');
  expect(result.label).toContain('已关闭');
  expect(result.citations).toEqual([]);
});
