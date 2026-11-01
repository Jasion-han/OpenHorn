// Real subprocess transports for runtimePrompt.test.ts. No provider/network calls.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const [mode, capturePath, commandJson] = process.argv.slice(2);
if (!capturePath) throw new Error("capture path required");
const record = (value: unknown) => appendFileSync(capturePath, `${JSON.stringify(value)}\n`);
record({ pid: process.pid });

if (mode === "agent") {
  const lines = createInterface({ input: process.stdin });
  const reply = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    record(message);
    if (message.method === "initialize") reply({ id: message.id, result: {} });
    if (message.method === "thread/start") {
      reply({ id: message.id, result: { thread: { id: "fixture-thread" } } });
    }
    if (message.method === "turn/start") {
      reply({ id: message.id, result: {} });
      reply({ method: "item/agentMessage/delta", params: { delta: "fixture response" } });
      reply({ method: "turn/completed", params: { status: "completed" } });
    }
  });
} else if (mode === "exec") {
  record({ command: JSON.parse(commandJson ?? "[]") });
  process.stdout.write(
    `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fixture response" } })}\n`,
  );
} else if (mode === "acp") {
  let turns = 0;
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  acp
    .agent({ name: "runtime-prompt-fixture" })
    .onRequest(acp.AGENT_METHODS.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: "runtime-prompt-fixture", version: "1" },
      authMethods: [],
    }))
    .onRequest(acp.AGENT_METHODS.session_new, () => ({ sessionId: "runtime-prompt-session" }))
    .onRequest(acp.AGENT_METHODS.session_prompt, async (ctx) => {
      record({ method: "session/prompt", params: ctx.params });
      await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "fixture response" },
        },
      });
      if (++turns === 2) setTimeout(() => process.exit(0), 50);
      return { stopReason: "end_turn" as const };
    })
    .connect(stream);
} else {
  throw new Error("unknown fixture mode");
}
