import { Hono, type MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import { createAdapter } from "../agent-adapters";
import { detectCredentialSources, getCredential } from "../services/credentialDetectionService";
import { PROVIDER_PRESETS } from "../services/providerPresets";
import { requireUser, type UserEnv } from "../utils/requestUser";

const credentials = new Hono<UserEnv>();

credentials.use("*", requireUser);

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Loopback-only guard for the raw-secret endpoints.
 *
 * OpenHorn is single-user / local-desktop only: the desktop client always talks
 * to the server over loopback. The endpoints below return host secrets (raw API
 * keys / CLI OAuth tokens), so we enforce a loopback boundary here — even if the
 * server is ever bound to a non-loopback interface, these secrets can never leak
 * to a remote client. The peer address is obtained via Bun's `server.requestIP`
 * (through hono/bun's `getConnInfo`), which is reliable under this stack.
 *
 * We fail closed: if the address is non-loopback OR cannot be determined, the
 * request is rejected with 403. Set OPENHORN_ALLOW_REMOTE_CREDENTIALS=true to
 * explicitly opt out of this restriction (not recommended).
 */
const requireLoopback: MiddlewareHandler<UserEnv> = async (c, next) => {
  if (process.env.OPENHORN_ALLOW_REMOTE_CREDENTIALS === "true") {
    return next();
  }

  let address: string | undefined;
  try {
    address = getConnInfo(c).remote.address;
  } catch {
    // Peer address not obtainable (e.g. not running under Bun) — fail closed.
    address = undefined;
  }

  if (address && LOOPBACK_ADDRESSES.has(address)) {
    return next();
  }

  return c.json({ error: "Credential sources are only accessible from the local machine" }, 403);
};

credentials.use("/sources/:id/key", requireLoopback);
credentials.use("/sources/:id/test", requireLoopback);

/**
 * GET /credentials/sources
 * Returns all detected credential sources without actual keys.
 */
credentials.get("/sources", async (c) => {
  const sources = await detectCredentialSources();
  return c.json({ sources });
});

/**
 * GET /credentials/sources/:id/key
 * Returns the actual API key for a specific credential source.
 */
credentials.get("/sources/:id/key", async (c) => {
  const sourceId = c.req.param("id");
  const result = await getCredential(sourceId);

  if ("error" in result) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({ apiKey: result.apiKey });
});

/**
 * POST /credentials/sources/:id/test
 * Tests if a credential works by making a simple API call.
 */
credentials.post("/sources/:id/test", async (c) => {
  const sourceId = c.req.param("id");

  const credResult = await getCredential(sourceId);
  if ("error" in credResult) {
    return c.json({ success: false, error: credResult.error });
  }

  try {
    // CLI OAuth tokens are scoped to the CLI tool itself and cannot be
    // validated by calling the standard API. If the token was successfully
    // read, treat it as valid — the user already confirmed the CLI works.
    if (sourceId === "cli-claude-code" || sourceId === "cli-codex" || sourceId === "cli-gemini") {
      if (credResult.apiKey && credResult.apiKey.length > 10) {
        return c.json({ success: true });
      }
      return c.json({ success: false, error: "Token 格式异常" });
    }

    // Environment variable / manual API keys — test via standard adapter
    let protocol = "openai";
    let baseUrl: string | undefined;

    if (sourceId.includes("anthropic")) {
      protocol = "anthropic";
      baseUrl = PROVIDER_PRESETS.anthropic.baseUrl;
    } else if (sourceId.includes("gemini")) {
      protocol = "google";
      baseUrl = PROVIDER_PRESETS.google.baseUrl;
    } else {
      baseUrl = PROVIDER_PRESETS.openai.baseUrl;
    }

    const adapter = createAdapter(protocol, credResult.apiKey, baseUrl);
    const model =
      protocol === "anthropic"
        ? "claude-sonnet-4-20250514"
        : protocol === "google"
          ? "gemini-2.0-flash"
          : "gpt-4o-mini";
    await adapter.chat({
      model,
      messages: [{ role: "user", content: "Hi" }],
      maxTokens: 1,
    });
    return c.json({ success: true });
  } catch (error) {
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : "Credential test failed",
    });
  }
});

/**
 * GET /credentials/presets
 * Returns the provider presets for the frontend.
 */
credentials.get("/presets", async (c) => {
  return c.json({ presets: PROVIDER_PRESETS });
});

export default credentials;
