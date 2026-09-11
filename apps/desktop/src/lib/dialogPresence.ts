/**
 * Whether any `[role="dialog"]` is currently in the document.
 *
 * The web preview's page lives in a native child webview stacked above the
 * DOM, so a dialog's overlay cannot cover it; the preview hides the native
 * view for as long as a dialog is open. One shared MutationObserver on
 * `document.body` serves every subscriber; mutations are coalesced per frame
 * and listeners only hear about changes. Radix keeps dialog content mounted
 * until its exit animation ends, so "gone from the DOM" also means the
 * overlay has finished fading out.
 */

type Listener = (open: boolean) => void;

const listeners = new Set<Listener>();
let observer: MutationObserver | null = null;
let frame: number | null = null;
let lastOpen = false;

export function isDialogPresent(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('[role="dialog"]') !== null;
}

function evaluate() {
  frame = null;
  const open = isDialogPresent();
  if (open === lastOpen) return;
  lastOpen = open;
  for (const listener of listeners) listener(open);
}

function schedule() {
  if (frame !== null) return;
  frame = window.requestAnimationFrame(evaluate);
}

/**
 * Calls `listener` with the current state right away and again whenever it
 * changes. Returns the unsubscribe function.
 */
export function subscribeDialogPresence(listener: Listener): () => void {
  if (typeof document === "undefined") {
    listener(false);
    return () => {};
  }
  if (observer === null) {
    lastOpen = isDialogPresent();
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  listeners.add(listener);
  listener(lastOpen);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    observer?.disconnect();
    observer = null;
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      frame = null;
    }
  };
}
