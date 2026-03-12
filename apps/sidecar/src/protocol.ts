import { z } from 'zod';

export const WsRequestSchema = z.object({
  type: z.literal('request'),
  requestId: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export type WsRequest = z.infer<typeof WsRequestSchema>;

export const WsResponseSchema = z.object({
  type: z.literal('response'),
  requestId: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export type WsResponse = z.infer<typeof WsResponseSchema>;

export const WsEventSchema = z.object({
  type: z.literal('event'),
  event: z.string().min(1),
  data: z.unknown().optional(),
});

export type WsEvent = z.infer<typeof WsEventSchema>;

export const IncomingMessageSchema = z.discriminatedUnion('type', [
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
  dir: z.string().default('.'),
});

export const FsReadParamsSchema = z.object({
  path: z.string().min(1),
});

export const FsWriteParamsSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export function parseIncomingJsonMessage(raw: string): IncomingMessage {
  const parsed = JSON.parse(raw);
  return IncomingMessageSchema.parse(parsed);
}

export function validateMethodParams(method: string, params: unknown): unknown {
  switch (method) {
    case 'auth.handshake':
      return AuthHandshakeParamsSchema.parse(params);
    case 'workspace.setCurrent':
      return WorkspaceSetCurrentParamsSchema.parse(params);
    case 'fs.list':
      return FsListParamsSchema.parse(params);
    case 'fs.read':
      return FsReadParamsSchema.parse(params);
    case 'fs.write':
      return FsWriteParamsSchema.parse(params);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

export function buildOkResponse(requestId: string, result: unknown): WsResponse {
  return { type: 'response', requestId, ok: true, result };
}

export function buildErrorResponse(requestId: string, error: string): WsResponse {
  return { type: 'response', requestId, ok: false, error };
}

export function buildEvent(event: string, data?: unknown): WsEvent {
  return { type: 'event', event, data };
}

