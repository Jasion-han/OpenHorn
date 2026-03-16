import { expect, test } from 'bun:test';
import { buildLiveContext } from './liveCapabilities';

test('buildLiveContext resolves weekday locally', async () => {
  const result = await buildLiveContext({
    prompt: '今天周几',
    now: new Date('2026-03-16T09:00:00+08:00'),
    timezone: 'Asia/Shanghai',
  });

  expect(result.status).toBe('live');
  expect(result.source.type).toBe('local');
  expect(result.userLabel).toContain('本地时间');
  expect(result.systemContext).toContain('Monday');
});

test('buildLiveContext resolves weather via structured live data', async () => {
  const result = await buildLiveContext({
    prompt: '上海今天天气怎么样',
    fetchImpl: async () =>
      new Response(JSON.stringify({
        current: {
          temperature_2m: 19.3,
          apparent_temperature: 18.8,
          weather_code: 1,
          wind_speed_10m: 12.4,
        },
        daily: {
          temperature_2m_max: [23.5],
          temperature_2m_min: [14.2],
          precipitation_probability_max: [35],
          weather_code: [1],
        },
      })) as Response,
  });

  expect(result.status).toBe('live');
  expect(result.route).toBe('structured_live');
  expect(result.source.type).toBe('weather');
  expect(result.userLabel).toContain('Shanghai');
  expect(result.systemContext).toContain('19.3');
  expect(result.systemContext).toContain('Partly cloudy');
});

test('buildLiveContext does not guess weather location from timezone or defaults', async () => {
  const result = await buildLiveContext({
    prompt: '今天天气怎么样',
    timezone: 'Asia/Shanghai',
  });

  expect(result.status).toBe('offline');
  expect(result.route).toBe('structured_live');
  expect(result.userLabel).toContain('缺少位置');
  expect(result.systemContext).toContain('Do not infer the user location');
});

test('buildLiveContext marks web-search routes as degraded when no provider exists', async () => {
  const result = await buildLiveContext({
    prompt: '最近 AI 圈有什么新闻',
    tavilyEnvKey: null,
  });

  expect(result.status).toBe('offline');
  expect(result.route).toBe('web_search');
  expect(result.userLabel).toContain('实时搜索未配置');
  expect(result.systemContext).toContain('Live search is not configured');
});

test('buildLiveContext uses tavily for web search when a key is available', async () => {
  const result = await buildLiveContext({
    prompt: '最近 AI 圈有什么新闻',
    tavilyEnvKey: 'env-key',
    fetchImpl: async (_input, init) => {
      expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer env-key');
      return new Response(JSON.stringify({
        results: [
          {
            title: 'AI Roundup',
            url: 'https://example.com/ai-roundup',
            content: 'New AI launches this week.',
            published_date: '2026-03-15',
          },
        ],
      }));
    },
  });

  expect(result.status).toBe('live');
  expect(result.route).toBe('web_search');
  expect(result.userLabel).toContain('实时搜索');
  expect(result.source.type).toBe('web_search');
  expect(result.citations).toHaveLength(1);
  expect(result.systemContext).toContain('AI Roundup');
});
