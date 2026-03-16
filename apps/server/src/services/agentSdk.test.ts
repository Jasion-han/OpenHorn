import { expect, test } from 'bun:test';
import { convertSdkEvent } from './agentSdk';

test('convertSdkEvent: rewrites generic network errors to actionable guidance', () => {
  const result = convertSdkEvent({
    type: 'result',
    subtype: 'error_during_execution',
    errors: ['network error'],
  });

  expect(result).toEqual({
    type: 'error',
    content: '网络错误：当前渠道可能不兼容 Claude Agent SDK。请检查 Provider、Base URL 和模型配置；如果你在使用 OpenAI 兼容中转，请把 Provider 改为 OpenAI/DeepSeek。',
  });
});

test('convertSdkEvent: surfaces auth status errors', () => {
  const result = convertSdkEvent({
    type: 'auth_status',
    error: 'network error',
  });

  expect(result).toEqual({
    type: 'error',
    content: '网络错误：当前渠道可能不兼容 Claude Agent SDK。请检查 Provider、Base URL 和模型配置；如果你在使用 OpenAI 兼容中转，请把 Provider 改为 OpenAI/DeepSeek。',
  });
});

test('convertSdkEvent: maps assistant invalid_request errors', () => {
  const result = convertSdkEvent({
    type: 'assistant',
    error: 'invalid_request',
    message: { content: [] },
  });

  expect(result).toEqual({
    type: 'error',
    content: '请求无效：当前渠道或模型可能不兼容 Claude Agent SDK。',
  });
});
