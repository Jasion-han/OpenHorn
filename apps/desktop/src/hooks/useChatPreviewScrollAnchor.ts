import type { Virtualizer } from "@tanstack/react-virtual";
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { type ChatScrollAnchor, findChatScrollAnchor } from "../lib/chatScrollAnchor";
import { type PreviewPanelState, usePreviewPanelStore } from "../stores/previewPanelStore";

function activeAnchoredPreview(state: PreviewPanelState) {
  const tab = state.tabs.find((tab) => tab.id === state.activeTabId);
  return tab?.kind === "attachment" || tab?.kind === "web" || tab?.kind === "local"
    ? tab
    : undefined;
}

function panelWidth(state: PreviewPanelState) {
  if (!state.isOpen || state.collapsed) return 0;
  if (
    window.innerWidth < 1100 &&
    ["attachment", "local"].includes(activeAnchoredPreview(state)?.kind ?? "")
  )
    return 0;
  return state.width;
}

/** Pin the actual clicked attachment or user link, including its offset inside a very long round. */
export function useChatPreviewScrollAnchor({
  viewportRef,
  virtualizerRef,
  conversationId,
  findRoundIndex,
  onCapture,
  canRestore,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
  virtualizerRef: RefObject<Virtualizer<HTMLDivElement, Element> | null>;
  conversationId: string | null;
  findRoundIndex: (key: string) => number;
  onCapture?: () => void;
  canRestore?: () => boolean;
}) {
  const [pinnedRoundKey, setPinnedRoundKey] = useState<string | null>(null);
  const restoringRef = useRef(false);
  const cancelRef = useRef<() => void>(() => {});
  const latest = useRef({ findRoundIndex, onCapture, canRestore });
  latest.current = { findRoundIndex, onCapture, canRestore };
  const cancel = useCallback(() => cancelRef.current(), []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !conversationId) return;
    let anchor: ChatScrollAnchor | undefined;
    let knownOrigins = new WeakSet<ChatScrollAnchor>();
    let frame = 0;
    let locked = false;
    let attempts = 0;
    let stable = 0;
    let previousGeometry = "";
    let observedWidth = viewport.clientWidth;
    let alive = true;
    const cancelFrame = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      restoringRef.current = false;
    };
    const clear = () => {
      cancelFrame();
      anchor = undefined;
      locked = false;
      knownOrigins = new WeakSet<ChatScrollAnchor>();
      setPinnedRoundKey(null);
    };
    cancelRef.current = clear;
    const tick = () => {
      frame = 0;
      if (!alive || !anchor || !locked) {
        restoringRef.current = false;
        return;
      }
      const element = findChatScrollAnchor(viewport, anchor);
      if (!element) {
        const index = latest.current.findRoundIndex(anchor.roundKey);
        if (index < 0) {
          clear();
          return;
        }
        virtualizerRef.current?.scrollToIndex(index, { align: "start" });
      } else {
        const delta =
          element.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          anchor.viewportOffset;
        if (Math.abs(delta) > 0.5) viewport.scrollTop += delta;
        const actual = element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
        const geometry = `${viewport.clientWidth}:${viewport.scrollHeight}:${Math.round(actual * 2)}`;
        stable = geometry === previousGeometry ? stable + 1 : 0;
        previousGeometry = geometry;
      }
      attempts++;
      if (stable >= 3 || attempts >= 90) {
        restoringRef.current = false;
        // Keep the return anchor while the preview owns it; release a closed
        // preview's pin only after the restored virtual layout has settled.
        const state = usePreviewPanelStore.getState();
        if (
          !state.tabs.some(
            (tab) =>
              (tab.kind === "attachment" || tab.kind === "web" || tab.kind === "local") &&
              tab.returnAnchor === anchor,
          )
        ) {
          // Keep guarding late width/height measurements until the user scrolls.
          // The row is visible again, so the extra virtual pin is no longer needed.
          setPinnedRoundKey(null);
        }
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    const restore = () => {
      if (!anchor || anchor.conversationId !== conversationId || !alive) return;
      if (latest.current.canRestore && !latest.current.canRestore()) {
        clear();
        return;
      }
      locked = true;
      restoringRef.current = true;
      attempts = 0;
      stable = 0;
      previousGeometry = "";
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const unsubscribe = usePreviewPanelStore.subscribe((next, previous) => {
      const attachment = activeAnchoredPreview(next);
      const oldAttachment = activeAnchoredPreview(previous);
      const removed = oldAttachment && !next.tabs.some((tab) => tab.id === oldAttachment.id);
      if (
        removed ||
        next.activeTabId !== previous.activeTabId ||
        attachment?.returnAnchor !== oldAttachment?.returnAnchor
      ) {
        // Closing a tab returns to that tab's source, even when a previous tab
        // becomes active in the same column. Explicit tab selection owns its source.
        const closedOrigin = removed ? oldAttachment.returnAnchor : undefined;
        const origin = removed
          ? closedOrigin && knownOrigins.has(closedOrigin)
            ? closedOrigin
            : anchor
          : attachment?.returnAnchor;
        anchor = origin?.conversationId === conversationId ? origin : undefined;
        if (anchor && !removed) {
          knownOrigins.add(anchor);
          latest.current.onCapture?.();
        }
        setPinnedRoundKey(anchor?.roundKey ?? null);
        if (!anchor) {
          locked = false;
          cancelFrame();
        }
      }
      if (
        panelWidth(next) !== panelWidth(previous) ||
        removed ||
        attachment?.returnAnchor !== oldAttachment?.returnAnchor
      )
        restore();
    });
    const resize = new ResizeObserver(() => {
      const widthChanged = observedWidth !== viewport.clientWidth;
      observedWidth = viewport.clientWidth;
      if (anchor && (widthChanged || locked)) restore();
    });
    resize.observe(viewport);
    if (viewport.firstElementChild) resize.observe(viewport.firstElementChild);
    const manual = () => {
      locked = false;
      cancelFrame();
      if (
        !usePreviewPanelStore
          .getState()
          .tabs.some(
            (tab) =>
              (tab.kind === "attachment" || tab.kind === "web" || tab.kind === "local") &&
              tab.returnAnchor === anchor,
          )
      ) {
        anchor = undefined;
        setPinnedRoundKey(null);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      )
        return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
        manual();
    };
    viewport.addEventListener("wheel", manual, { passive: true });
    viewport.addEventListener("touchstart", manual, { passive: true });
    viewport.addEventListener("pointerdown", manual);
    viewport.addEventListener("keydown", key);
    return () => {
      alive = false;
      cancelFrame();
      unsubscribe();
      resize.disconnect();
      viewport.removeEventListener("wheel", manual);
      viewport.removeEventListener("touchstart", manual);
      viewport.removeEventListener("pointerdown", manual);
      viewport.removeEventListener("keydown", key);
      cancelRef.current = () => {};
      setPinnedRoundKey(null);
    };
  }, [viewportRef, virtualizerRef, conversationId]);
  return { pinnedRoundKey, restoringRef, cancel };
}
