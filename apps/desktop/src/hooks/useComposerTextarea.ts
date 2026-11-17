import type { RefObject } from "react";
import { useLayoutEffect, useRef } from "react";

const TEXT_METRICS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontStretch",
  "fontVariant",
  "fontKerning",
  "fontFeatureSettings",
  "fontVariantLigatures",
  "letterSpacing",
  "lineHeight",
  "textIndent",
  "textTransform",
  "textAlign",
  "tabSize",
  "wordSpacing",
  "wordBreak",
  "overflowWrap",
  "whiteSpace",
  "direction",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
] as const;

/** Measure only; never mutate the native selection or IME composition. */
function revealInsertionPoint(field: HTMLTextAreaElement, mirror: HTMLDivElement) {
  if (document.activeElement !== field || field.clientHeight >= field.scrollHeight) return;
  const style = getComputedStyle(field);
  for (const key of TEXT_METRICS) mirror.style[key] = style[key];
  mirror.style.width = `${field.getBoundingClientRect().width - (field.offsetWidth - field.clientWidth)}px`;
  const caret = field.selectionDirection === "backward" ? field.selectionStart : field.selectionEnd;
  mirror.textContent = field.value.slice(0, caret);
  const marker = document.createElement("span");
  // Include the suffix so wrapping a word around a mid-text caret matches the textarea.
  marker.textContent = field.value.slice(caret) || "\u200b";
  mirror.append(marker);
  const top = marker.offsetTop;
  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4;
  const bottom = top + lineHeight;
  if (top < field.scrollTop) field.scrollTop = Math.max(0, top);
  else if (bottom > field.scrollTop + field.clientHeight)
    field.scrollTop = bottom - field.clientHeight;
}

export function useComposerTextarea({
  fieldRef,
  value,
  minHeight,
  maxHeight,
  onLayout,
}: {
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  minHeight: number;
  maxHeight: number;
  onLayout?: (field: HTMLTextAreaElement) => void;
}) {
  const resizeRef = useRef<(() => void) | null>(null);
  // A persistent native mirror avoids inserting/removing a layout probe on every key.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const mirror = document.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    mirror.style.cssText =
      "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;white-space:pre-wrap;";
    document.body.append(mirror);
    let frame = 0,
      live = true,
      lastWidth = -1;
    const sync = () => {
      revealInsertionPoint(field, mirror);
      onLayout?.(field);
    };
    const resize = () => {
      const previousScroll = field.scrollTop;
      field.style.overflowY = "hidden";
      field.style.height = "0px";
      const border = field.offsetHeight - field.clientHeight;
      const height = Math.max(minHeight, Math.min(maxHeight, field.scrollHeight + border));
      field.style.height = `${height}px`;
      field.style.overflowY = field.scrollHeight > field.clientHeight ? "auto" : "hidden";
      field.scrollTop = previousScroll;
      sync();
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (live) sync();
      });
    };
    resizeRef.current = resize;
    const input = () => {
      resize();
      schedule();
    };
    field.addEventListener("input", input);
    for (const event of ["keyup", "click", "select", "compositionupdate", "compositionend"])
      field.addEventListener(event, schedule);
    const observer = new ResizeObserver(() => {
      const width = field.getBoundingClientRect().width;
      if (width === lastWidth) return;
      lastWidth = width;
      resize();
    });
    observer.observe(field.parentElement ?? field);
    resize();
    void document.fonts.ready.then(() => {
      if (live) resize();
    });
    return () => {
      live = false;
      resizeRef.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      field.removeEventListener("input", input);
      for (const event of ["keyup", "click", "select", "compositionupdate", "compositionend"])
        field.removeEventListener(event, schedule);
      mirror.remove();
    };
  }, [fieldRef, minHeight, maxHeight, onLayout]);

  // Controlled/programmatic changes (handoff, history recall, clear) also resize before paint.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a controlled value change requires measuring the updated DOM.
  useLayoutEffect(() => {
    resizeRef.current?.();
  }, [value]);
}
