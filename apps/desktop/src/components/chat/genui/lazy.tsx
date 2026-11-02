import { type ComponentProps, createElement, useEffect, useSyncExternalStore } from "react";
import { TEXT_ONLY_RESPONSE_POLICY } from "../../../lib/genui/responsePolicy";
import { useGenUiStore } from "../../../stores/genUiStore";

// @openuidev/react-lang mounts its Inspect overlay into document.body when first
// evaluated under NODE_ENV=development, unless this flag (its own dedupe guard)
// is already set. The overlay covers the chat and advertises a hosted service;
// production builds drop it anyway. Every app path to the library goes through
// the dynamic imports below, so setting it here runs before the library does.
(globalThis as Record<symbol, unknown>)[Symbol.for("openui.devtools.autoMount")] = true;

/**
 * The OpenUI runtime, the component library and the full lucide icon map are
 * several hundred KB; they load only when an answer contains a UI block or an
 * Auto run needs the prompt section. Preparing a text-only response avoids them.
 */
type GenUiBlockComponent = typeof import("./GenUiBlock")["GenUiBlock"];
let loadedBlock: GenUiBlockComponent | null = null;
let blockLoad: Promise<GenUiBlockComponent> | null = null;
const blockListeners = new Set<() => void>();

function subscribeBlock(listener: () => void): () => void {
  blockListeners.add(listener);
  return () => {
    blockListeners.delete(listener);
  };
}

const blockSnapshot = () => loadedBlock;

function loadBlock(): Promise<GenUiBlockComponent> {
  if (!blockLoad) {
    blockLoad = import("./GenUiBlock").then(
      ({ GenUiBlock }) => {
        loadedBlock = GenUiBlock;
        for (const listener of blockListeners) listener();
        return GenUiBlock;
      },
      (error: unknown) => {
        blockLoad = null;
        throw error;
      },
    );
  }
  return blockLoad;
}

export function LazyGenUiBlock(props: ComponentProps<GenUiBlockComponent>) {
  const Block = useSyncExternalStore(subscribeBlock, blockSnapshot, blockSnapshot);
  useEffect(() => {
    if (Block) return;
    void loadBlock().catch(() => {
      // A later mount can retry; retained consumers share its successful load.
    });
  }, [Block]);

  // React 19 holds the first suspended render for about 300ms even when the
  // import has finished. A shared snapshot publishes it as soon as it is ready.
  // Once loaded, the cached component also preserves immediate remounts.
  return Block ? createElement(Block, props) : props.fallback;
}

/** Auto uses the full library; text-only needs only a lightweight output policy. */
export async function loadGenUiSection(enabled: boolean): Promise<string | null> {
  if (!enabled) return TEXT_ONLY_RESPONSE_POLICY;
  const { buildGenUiSystemPrompt } = await import("./prompt");
  return buildGenUiSystemPrompt();
}

/**
 * The section for the preference's value *now*. Send / retry / edit handlers must
 * use this rather than a value captured at render: MessageBubble's memo keeps
 * the onRetry closure from the render a bubble first appeared in, so a
 * render-time `enabled` would be stale after the user changes the preference.
 */
export function loadCurrentGenUiSection(): Promise<string | null> {
  return loadGenUiSection(useGenUiStore.getState().enabled);
}
