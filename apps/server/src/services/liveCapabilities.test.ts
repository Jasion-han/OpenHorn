import { expect, test } from 'bun:test';
import { routeLiveQuery } from './liveCapabilities';

test('routeLiveQuery classifies local time questions', () => {
  expect(routeLiveQuery('今天周几')).toEqual({
    type: 'local',
    needsCitation: false,
  });
});

test('routeLiveQuery classifies weather questions', () => {
  expect(routeLiveQuery('今天天气怎么样').type).toBe('structured_live');
});

test('routeLiveQuery classifies recent-news questions', () => {
  expect(routeLiveQuery('最近 AI 圈有什么新闻').type).toBe('web_search');
});

test('routeLiveQuery classifies research-heavy requests separately', () => {
  expect(routeLiveQuery('帮我比较最近几家 AI 公司的发布和融资').type).toBe('research');
});

test('routeLiveQuery leaves non-live prompts as direct model', () => {
  expect(routeLiveQuery('把这段话翻译成英文').type).toBe('direct_model');
});
