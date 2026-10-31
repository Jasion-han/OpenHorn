import { exec } from "node:child_process";
import { buildAnthropicBillingMarker, VERIFIED_CLAUDE_CODE_VERSION } from "adapters";

/**
 * Resolves the Claude Code OAuth billing marker for this machine. The rules
 * themselves (marker format, own `system[0]` block, Bearer auth, model id) live
 * in `adapters` (`anthropic-oauth.ts`); this only supplies the `cc_version`,
 * taken from the installed CLI so the attribution tracks whatever the user
 * actually has. An OAuth token only ever comes from a CLI login, so the CLI is
 * present whenever this runs; the verified constant is a last resort.
 *
 * The probe runs at most once per process: the in-flight promise itself is
 * cached, so concurrent first requests share one `claude --version` and every
 * later request resolves immediately. It is async (not `execSync`) so the
 * first probe never stalls the sidecar's event loop for other connections.
 */
let cachedMarker: Promise<string> | null = null;
export function resolveClaudeBillingMarker(): Promise<string> {
  if (!cachedMarker) {
    cachedMarker = new Promise<string>((resolve) => {
      exec("claude --version", { timeout: 5000 }, (error, stdout) => {
        const version = error
          ? VERIFIED_CLAUDE_CODE_VERSION
          : (String(stdout).match(/(\d+\.\d+\.\d+)/)?.[1] ?? VERIFIED_CLAUDE_CODE_VERSION);
        resolve(buildAnthropicBillingMarker(version));
      });
    });
  }
  return cachedMarker;
}
