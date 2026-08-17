// Standalone stdio ACP agent used by acp.smoke.test.ts. Speaks protocol v1
// over ndjson JSON-RPC on stdin/stdout, exactly like a real ACP agent binary,
// so the test exercises the same transport path the acp runtime will use.
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

acp
  .agent({ name: "fake-acp-agent" })
  .onRequest(acp.AGENT_METHODS.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: "fake-acp-agent", version: "0.0.1" },
    authMethods: [],
  }))
  .onRequest(acp.AGENT_METHODS.session_new, () => ({ sessionId: "sess_fake_1" }))
  .onRequest(acp.AGENT_METHODS.session_prompt, async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const notify = (update: acp.SessionUpdate) =>
      ctx.client.notify(acp.CLIENT_METHODS.session_update, { sessionId, update });
    await notify({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking..." },
    });
    await notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello " },
    });
    await notify({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "read file",
      kind: "read",
      status: "in_progress",
    });
    await notify({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" });
    await notify({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "from fake agent" },
    });
    await notify({ sessionUpdate: "usage_update", used: 1234, size: 200000 });
    return { stopReason: "end_turn" as const };
  })
  .onNotification(acp.AGENT_METHODS.session_cancel, () => {})
  .connect(stream);
