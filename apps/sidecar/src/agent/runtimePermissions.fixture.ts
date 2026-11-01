// Deterministic subprocesses exercising the real transports; never calls a model.

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const [mode, capturePath, scenario = ""] = process.argv.slice(2);
const record = (value: unknown) => appendFileSync(capturePath, `${JSON.stringify(value)}\n`);
record({ pid: process.pid });

if (mode === "codex") {
  const reply = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  let approvalCount = 0;
  const complete = () =>
    reply({
      method: "turn/completed",
      params: {
        threadId: "fixture",
        turn: {
          id: "turn",
          status: scenario === "failed" ? "failed" : "completed",
          error: scenario === "failed" ? { message: "fixture upstream failure" } : null,
        },
      },
    });
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    record(message);
    if (message.method === "initialize") {
      if (scenario === "initializing") return;
      // Opposite JSON-RPC directions are independent id namespaces.
      if (scenario === "collision")
        reply({ id: message.id, method: "unknown/fixture", params: {} });
      reply({ id: message.id, result: {} });
    } else if (message.method === "thread/start") {
      reply({ id: message.id, result: { thread: { id: "fixture" } } });
    } else if (message.method === "turn/start") {
      reply({ id: message.id, result: {} });
      if (scenario === "descendant") {
        const descendant = spawn(
          process.execPath,
          ["-e", 'setTimeout(() => require("node:fs").writeFileSync("marker", "escaped"), 300)'],
          { cwd: process.cwd(), stdio: "ignore" },
        );
        record({ descendantPid: descendant.pid });
        return;
      }
      if (scenario === "permissions" || scenario === "pending") {
        reply({
          id: "command-approval",
          method: "item/commandExecution/requestApproval",
          params: {
            itemId: "cmd",
            command: "fixture command",
            cwd: process.cwd(),
            reason: "fixture reason",
          },
        });
      } else complete();
    } else if (!message.method && message.id === "command-approval") {
      if (scenario === "pending") return;
      reply({
        id: 42,
        method: "item/fileChange/requestApproval",
        params: { itemId: "file", reason: "fixture file change", grantRoot: process.cwd() },
      });
    } else if (!message.method && message.id === 42) {
      if (++approvalCount === 1) complete();
    }
  });
} else if (mode === "acp") {
  let turns = 0;
  let cancelPrompt: (() => void) | undefined;
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  acp
    .agent({ name: "permission-fixture" })
    .onRequest(acp.AGENT_METHODS.initialize, async () => {
      record({ method: "initialize" });
      if (scenario === "initializing") await Bun.sleep(150);
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
        authMethods: [],
      };
    })
    .onRequest(acp.AGENT_METHODS.session_new, () => ({ sessionId: `permission-${process.pid}` }))
    .onRequest(acp.AGENT_METHODS.session_prompt, async (ctx) => {
      record({ method: "session/prompt", params: ctx.params });
      if (scenario === "late-write") {
        await new Promise<void>((resolve) => {
          cancelPrompt = resolve;
        });
        return { stopReason: "cancelled" as const };
      }
      const permission = await ctx.client.request(acp.CLIENT_METHODS.session_request_permission, {
        sessionId: ctx.params.sessionId,
        toolCall: {
          toolCallId: `command-${turns}`,
          title: "shell",
          kind: "execute",
          rawInput: { command: "rm -rf /fixture-only" },
        },
        options: [
          { optionId: "allow", kind: "allow_once", name: "Allow" },
          { optionId: "deny", kind: "reject_once", name: "Deny" },
        ],
      });
      record({ permission });
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
    .onNotification(acp.AGENT_METHODS.session_cancel, async (ctx) => {
      record({ method: "session/cancel" });
      if (scenario === "late-write") {
        try {
          await ctx.client.request(acp.CLIENT_METHODS.fs_write_text_file, {
            sessionId: ctx.params.sessionId,
            path: `${dirname(capturePath)}/marker`,
            content: "escaped",
          });
          record({ lateWrite: "accepted" });
        } catch (error) {
          record({ lateWrite: "rejected", lateWriteError: String(error) });
        }
        cancelPrompt?.();
      }
    })
    .connect(stream);
} else throw new Error("unknown fixture mode");
