import { describe, expect, it } from 'bun:test';
import { createSseStream } from './sse';

async function readStreamText(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode(new Uint8Array(), { stream: false });
  return out;
}

describe('createSseStream', () => {
  it('emits error events with both message and content for compatibility', async () => {
    const stream = createSseStream(async () => {
      throw new Error('boom');
    });

    const text = await readStreamText(stream);
    const line = text.split('\n').find((l) => l.startsWith('data: ')) || '';
    const payload = JSON.parse(line.replace(/^data:\s*/, ''));

    expect(payload.type).toBe('error');
    expect(payload.message).toBe('boom');
    expect(payload.content).toBe('boom');
  });
});
