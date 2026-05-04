import type { ProviderPreset } from "shared";

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai: {
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    name: "OpenAI",
  },
  anthropic: {
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    name: "Anthropic",
  },
  google: {
    protocol: "google",
    baseUrl: "https://generativelanguage.googleapis.com",
    name: "Google Gemini",
  },
  deepseek: {
    protocol: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    name: "DeepSeek",
  },
  qwen: {
    protocol: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    name: "通义千问",
  },
  kimi: {
    protocol: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    name: "Kimi (Moonshot)",
  },
  glm: {
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    name: "GLM (智谱)",
  },
  doubao: {
    protocol: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    name: "豆包 (字节)",
  },
  minimax: {
    protocol: "openai",
    baseUrl: "https://api.minimax.chat/v1",
    name: "MiniMax",
  },
  custom: {
    protocol: "openai",
    baseUrl: "",
    name: "自定义",
  },
};
