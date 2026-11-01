import { type ComponentProps, createElement, useEffect, useState } from "react";
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
type GenUiBlockComponent = typeof import("./GenUiBlock")["GenUiBlock"];
let loadedBlock: GenUiBlockComponent | null = null;
let blockLoad: Promise<GenUiBlockComponent> | null = null;

function loadBlock(): Promise<GenUiBlockComponent> {
  if (!blockLoad) {
    blockLoad = import("./GenUiBlock").then(
      ({ GenUiBlock }) => {
        loadedBlock = GenUiBlock;
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
  const [Block, setBlock] = useState<GenUiBlockComponent | null>(() => loadedBlock);
  useEffect(() => {
    if (Block) return;
    let mounted = true;
    void loadBlock().then(
      (component) => {
        if (mounted) setBlock(() => component);
      },
      () => {
        // Keep readable source on a chunk failure; a later mount can retry.
      },
    );
    return () => {
      mounted = false;
    };
  }, [Block]);

  // React 19 holds the first suspended render for about 300ms even when the
  // import has finished. Ordinary state publishes it as soon as it is ready.
  // Once loaded, the cached component also preserves immediate remounts.
  return Block ? createElement(Block, props) : props.fallback;
}

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
