// Smoke test for @agentclientprotocol/sdk under Bun with a real child-process
// stdio transport. The SDK has no public Bun precedent, so this gates the acp
// runtime: it must prove ndJsonStream + node:child_process stdio interop works
// end to end (initialize → session/new → session/prompt → streamed updates →
// stop) before any runtime code builds on it.
import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const FIXTURE_PATH = new URL("./acpFakeAgent.fixture.ts", import.meta.url).pathname;

let child: ChildProcess | null = null;

afterAll(() => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
});

describe("ACP SDK smoke (Bun + child stdio)", () => {
  test("handshake, prompt turn, and streamed updates round-trip through a spawned agent", async () => {
    child = spawn(process.execPath, [FIXTURE_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const spawned = child;
    const stderrChunks: string[] = [];
    spawned.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    if (!spawned.stdin || !spawned.stdout) {
      throw new Error("fixture agent spawned without stdio pipes");
    }
    const stream = acp.ndJsonStream(
      Writable.toWeb(spawned.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(spawned.stdout) as ReadableStream<Uint8Array>,
    );

    try {
      const outcome = await acp
        .client({ name: "openhorn-acp-smoke" })
        .onRequest(acp.CLIENT_METHODS.session_request_permission, () => ({
          outcome: { outcome: "cancelled" as const },
        }))
        .connectWith(stream, async (ctx) => {
          const init = await ctx.request(acp.AGENT_METHODS.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "openhorn-acp-smoke", version: "0.0.1" },
          });
          return ctx.buildSession(process.cwd()).withSession(async (session) => {
            const updates: acp.SessionUpdate[] = [];
            const promptDone = session.prompt("hello");
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") {
                await promptDone;
                return { init, updates, stopReason: message.stopReason };
              }
              updates.push(message.update);
            }
          });
        });

      expect(outcome.init.protocolVersion).toBe(acp.PROTOCOL_VERSION);
      expect(outcome.init.agentInfo?.name).toBe("fake-acp-agent");
      expect(outcome.stopReason).toBe("end_turn");

      const kinds = outcome.updates.map((update) => update.sessionUpdate);
      expect(kinds).toEqual([
        "agent_thought_chunk",
        "agent_message_chunk",
        "tool_call",
        "tool_call_update",
        "agent_message_chunk",
        "usage_update",
      ]);

      const text = outcome.updates
        .filter((update) => update.sessionUpdate === "agent_message_chunk")
        .map((update) => (update.content.type === "text" ? update.content.text : ""))
        .join("");
      expect(text).toBe("Hello from fake agent");

      const usage = outcome.updates.find((update) => update.sessionUpdate === "usage_update");
      expect(usage?.sessionUpdate === "usage_update" && usage.used).toBe(1234);
    } catch (err) {
      throw new Error(
        `smoke failed: ${err instanceof Error ? err.message : String(err)}; agent stderr: ${stderrChunks.join("")}`,
      );
    } finally {
      spawned.kill("SIGKILL");
    }
  }, 15000);
});
