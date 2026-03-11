import type { AgentEvent } from './agentService';

type SdkMessage = {
  type: string;
  [key: string]: unknown;
};

type SdkOptions = {
  apiKey: string;
  model: string;
  prompt: string;
  cwd?: string;
  mcpServers?: Record<string, Record<string, unknown>>;
  baseUrl?: string;
};

export async function* runClaudeAgentSdk(options: SdkOptions): AsyncGenerator<AgentEvent> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');

  const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const previousApiKey = process.env.ANTHROPIC_API_KEY;

  if (options.baseUrl) {
    process.env.ANTHROPIC_BASE_URL = options.baseUrl;
  }
  if (options.apiKey) {
    process.env.ANTHROPIC_API_KEY = options.apiKey;
  }

  const query = sdk.query({
    prompt: options.prompt,
    options: {
      model: options.model,
      apiKey: options.apiKey,
      cwd: options.cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(options.mcpServers && Object.keys(options.mcpServers).length > 0
        ? { mcpServers: options.mcpServers }
        : {}),
    },
  });

  try {
    for await (const message of query as AsyncIterable<SdkMessage>) {
      const converted = convertSdkEvent(message);
      if (converted) {
        yield converted;
      }
    }
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
    }

    if (previousApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousApiKey;
    }
  }

  yield { type: 'done' };
}

export function convertSdkEvent(message: SdkMessage): AgentEvent | null {
  if (message.type === 'assistant' && message.message && typeof message.message === 'object') {
    const content = (message.message as { content?: Array<{ type?: string; text?: string }> }).content || [];
    const text = content
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('');
    if (text) {
      return { type: 'text', content: text };
    }
  }

  if (message.type === 'stream_event' && message.event && typeof message.event === 'object') {
    const event = message.event as { type?: string; delta?: { text?: string } };
    if (event.type === 'content_block_delta' && event.delta?.text) {
      return { type: 'text', content: event.delta.text };
    }
  }

  if (message.type === 'text' && typeof message.text === 'string') {
    return { type: 'text', content: message.text };
  }

  if (message.type === 'tool_start') {
    return {
      type: 'tool_start',
      toolName: typeof message.tool_name === 'string' ? message.tool_name : undefined,
      toolInput: message.tool_input,
    };
  }

  if (message.type === 'tool_result') {
    return {
      type: 'tool_result',
      content: typeof message.content === 'string' ? message.content : undefined,
    };
  }

  if (message.type === 'tool_progress') {
    return {
      type: 'tool_start',
      toolName: typeof message.tool_name === 'string' ? message.tool_name : undefined,
    };
  }

  if (message.type === 'tool_use_summary') {
    return {
      type: 'tool_result',
      content: typeof message.summary === 'string' ? message.summary : undefined,
    };
  }

  return null;
}
