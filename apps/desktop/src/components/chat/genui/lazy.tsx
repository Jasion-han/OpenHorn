import { lazy } from "react";
import { useGenUiStore } from "../../../stores/genUiStore";

// @openuidev/react-lang mounts its Inspect overlay into document.body when first
// evaluated under NODE_ENV=development, unless this flag (its own dedupe guard)
// is already set. The overlay covers the chat and advertises a hosted service;
// production builds drop it anyway. Every app path to the library goes through
// the dynamic imports below, so setting it here runs before the library does.
(globalThis as Record<symbol, unknown>)[Symbol.for("openui.devtools.autoMount")] = true;

/**
 * The OpenUI runtime, the component library and the full lucide icon map are
 * several hundred KB; they load only when an answer contains a UI block or a
 * run needs the prompt section, so conversations without generative UI pay
 * nothing for it.
 */
export const LazyGenUiBlock = lazy(() =>
  import("./GenUiBlock").then((mod) => ({ default: mod.GenUiBlock })),
);

/** The system-prompt section when interactive answers are on, otherwise null. */
export async function loadGenUiSection(enabled: boolean): Promise<string | null> {
  if (!enabled) return null;
  const { buildGenUiSystemPrompt } = await import("./prompt");
  return buildGenUiSystemPrompt();
}

/**
 * The section for the toggle's value *now*. Send / retry / edit handlers must
 * use this rather than a value captured at render: MessageBubble's memo keeps
 * the onRetry closure from the render a bubble first appeared in, so a
 * render-time `enabled` would be stale after the user flips the toggle.
 */
export function loadCurrentGenUiSection(): Promise<string | null> {
  return loadGenUiSection(useGenUiStore.getState().enabled);
}
