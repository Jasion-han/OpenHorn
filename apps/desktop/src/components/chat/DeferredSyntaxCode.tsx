import { type ComponentProps, type ReactNode, useEffect, useSyncExternalStore } from "react";

type Highlighter = typeof import("./DesktopSyntaxHighlighter")["DesktopSyntaxHighlighter"];
let component: Highlighter | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
const snapshot = () => component;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function load() {
  if (!pending)
    pending = import("./DesktopSyntaxHighlighter")
      .then(({ DesktopSyntaxHighlighter }) => {
        component = DesktopSyntaxHighlighter;
        for (const listener of listeners) listener();
      })
      .catch(() => {
        pending = null;
      });
  return pending;
}

/** Keep the complete plain-code view usable while optional highlighting loads. */
export function DeferredSyntaxCode({
  fallback,
  ...props
}: ComponentProps<Highlighter> & { fallback: ReactNode }) {
  const Highlighter = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (!Highlighter) void load();
  }, [Highlighter]);
  return Highlighter ? <Highlighter {...props} /> : fallback;
}
