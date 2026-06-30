import { z } from "zod";

export const WsRequestSchema = z.object({
  type: z.literal("request"),
  requestId: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export type WsRequest = z.infer<typeof WsRequestSchema>;

export const WsResponseSchema = z.object({
  type: z.literal("response"),
  requestId: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export type WsResponse = z.infer<typeof WsResponseSchema>;

export const WsEventSchema = z.object({
  type: z.literal("event"),
  event: z.string().min(1),
  data: z.unknown().optional(),
});

export type WsEvent = z.infer<typeof WsEventSchema>;

export const IncomingMessageSchema = z.discriminatedUnion("type", [
  WsRequestSchema,
  WsResponseSchema,
  WsEventSchema,
]);

export type IncomingMessage = z.infer<typeof IncomingMessageSchema>;

export const AuthHandshakeParamsSchema = z.object({
  token: z.string().min(1),
});

export const WorkspaceSetCurrentParamsSchema = z.object({
  root: z.string().min(1),
});

export const FsListParamsSchema = z.object({
  dir: z.string().default("."),
});

export const FsReadParamsSchema = z.object({
  path: z.string().min(1),
});

export const FsWriteParamsSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const ApprovalsRespondParamsSchema = z.object({
  toolUseId: z.string().min(1),
  allow: z.boolean(),
});

export const AttachmentPartSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("image"),
    mediaType: z.string(),
    dataBase64: z.string(),
    fileName: z.string().optional(),
  }),
  z.object({
    kind: z.literal("file"),
    fileName: z.string(),
    mediaType: z.string(),
    text: z.string(),
  }),
]);

export const AgentRunParamsSchema = z.object({
  prompt: z.string().min(1),
  apiKey: z.string().default(""),
  model: z.string().min(1),
  baseUrl: z.string().optional(),
  protocol: z.enum(["anthropic", "openai", "codex_cli"]).optional(),
  sdkSessionId: z.string().optional(),
  permissionMode: z.enum(["default", "full-access"]).optional(),
  systemPrompt: z.string().optional(),
  conversationHistory: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .optional(),
  webSearchEnabled: z.boolean().optional(),
  tavilyApiKey: z.string().optional(),
  attachments: z.array(AttachmentPartSchema).optional(),
});

export const AgentCancelParamsSchema = z.object({
  runId: z.string().min(1),
});

export const ChatStreamParamsSchema = z.object({
  apiKey: z.string().default(""),
  baseUrl: z.string().optional(),
  protocol: z.string().min(1),
  model: z.string().min(1),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
});

export const CheckpointRollbackParamsSchema = z.object({
  runId: z.string().min(1),
});

export const AuthDetectCredentialsParamsSchema = z.object({}).optional();

export function parseIncomingJsonMessage(raw: string): IncomingMessage {
  const parsed = JSON.parse(raw);
  return IncomingMessageSchema.parse(parsed);
}

export function validateMethodParams(method: string, params: unknown): unknown {
  switch (method) {
    case "auth.handshake":
      return AuthHandshakeParamsSchema.parse(params);
    case "workspace.setCurrent":
      return WorkspaceSetCurrentParamsSchema.parse(params);
    case "fs.list":
      return FsListParamsSchema.parse(params);
    case "fs.read":
      return FsReadParamsSchema.parse(params);
    case "fs.write":
      return FsWriteParamsSchema.parse(params);
    case "approvals.respond":
      return ApprovalsRespondParamsSchema.parse(params);
    case "chat.stream":
      return ChatStreamParamsSchema.parse(params);
    case "agent.run":
      return AgentRunParamsSchema.parse(params);
    case "agent.cancel":
      return AgentCancelParamsSchema.parse(params);
    case "checkpoint.rollback":
      return CheckpointRollbackParamsSchema.parse(params);
    case "auth.detectCredentials":
      return params ?? {};
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

export function buildOkResponse(requestId: string, result: unknown): WsResponse {
  return { type: "response", requestId, ok: true, result };
}

export function buildErrorResponse(requestId: string, error: string): WsResponse {
  return { type: "response", requestId, ok: false, error };
}

export function buildEvent(event: string, data?: unknown): WsEvent {
  return { type: "event", event, data };
}
