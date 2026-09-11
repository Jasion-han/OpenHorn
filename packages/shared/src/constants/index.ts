export const PROVIDERS = {
  openai: {
    name: "OpenAI",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    defaultModel: "gpt-4o",
    baseUrl: "https://api.openai.com/v1",
  },
  anthropic: {
    name: "Anthropic",
    models: ["claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022", "claude-3-haiku-20240307"],
    defaultModel: "claude-3-5-sonnet-20241022",
    baseUrl: "https://api.anthropic.com",
  },
  deepseek: {
    name: "DeepSeek",
    models: ["deepseek-chat", "deepseek-coder"],
    defaultModel: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
  },
  google: {
    name: "Google",
    models: ["gemini-1.5-pro", "gemini-1.5-flash"],
    defaultModel: "gemini-1.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1",
  },
} as const;

export const DEFAULT_CONTEXT_LENGTH = 4096;

export const MAX_CONTEXT_LENGTH = 100000;

// --- Import center ---
/** Maximum number of per-item entries kept on an ImportPart; beyond that only the counters grow. */
export const IMPORT_PART_ITEMS_LIMIT = 200;
/** Upper bound on conversations a single `POST /import/local/run` processes; callers page with explicit `sessionIds`. */
export const LOCAL_IMPORT_RUN_MAX_CONVERSATIONS = 500;
/** Settings key holding the JSON PromptTemplate[] shown in the slash panel's prompt group. */
export const PROMPT_TEMPLATES_SETTING_KEY = "prompts.templates";
/** Settings key of the global system prompt that imported instructions are appended to. */
export const GLOBAL_SYSTEM_PROMPT_SETTING_KEY = "chat.systemPrompt";
