import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getSidebarLabel, type SidebarLabelKey } from "../../lib/i18n/agent";
import type { Conversation } from "../../types/chat";

type Group = {
  label: Extract<
    SidebarLabelKey,
    "sidebar.group.today" | "sidebar.group.yesterday" | "sidebar.group.earlier"
  >;
  items: Conversation[];
};
type Row = { key: string; label: Group["label"] } | { key: string; conversation: Conversation };

/** Only the ordinary unbounded history is windowed; projects keep their existing pages. */
export function SidebarConversationGroups({
  groups,
  renderConversation,
  retainedConversationIds,
}: {
  groups: Group[];
  renderConversation(conversation: Conversation): ReactNode;
  retainedConversationIds: readonly string[];
}) {
  const rows = useMemo<Row[]>(
    () =>
      groups.flatMap((group) => [
        { key: `group:${group.label}`, label: group.label },
        ...group.items.map((conversation) => ({
          key: `conversation:${conversation.id}`,
          conversation,
        })),
      ]),
    [groups],
  );
  const indexes = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
  const root = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const id = useId();
  const rowId = (key: string) => `${id}-${encodeURIComponent(key)}`;
  useLayoutEffect(() => {
    const element = root.current;
    const scroll = element?.closest<HTMLElement>("[data-radix-scroll-area-viewport]");
    if (!element || !scroll) return;
    setViewport(scroll);
    const measure = () =>
      setMargin(
        element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
    return () => observer.disconnect();
  }, []);
  const focusedIndex = focusedKey === null ? undefined : indexes.get(focusedKey);
  const retainedIndexes = useMemo(
    () =>
      [
        ...retainedConversationIds.map((id) => indexes.get(`conversation:${id}`)),
        focusedIndex,
      ].filter((index): index is number => index !== undefined),
    [retainedConversationIds, indexes, focusedIndex],
  );
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const visible = defaultRangeExtractor(range);
      // A focused row also owns any portalled menu: keep it mounted while scrolling.
      for (const index of retainedIndexes) if (!visible.includes(index)) visible.push(index);
      return visible.sort((a, b) => a - b);
    },
    [retainedIndexes],
  );
  const getItemKey = useCallback((index: number) => rows[index].key, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewport,
    getItemKey,
    estimateSize: (index) => ("label" in rows[index] ? 29 : 40),
    scrollMargin: margin,
    overscan: 6,
    rangeExtractor,
    useFlushSync: false,
  });
  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    const element = document
      .getElementById(rowId(key))
      ?.querySelector<HTMLElement>('[role="button"]');
    if (element) {
      pendingFocus.current = null;
      element.focus({ preventScroll: true });
    }
  });
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.getAttribute("role") !== "button") return;
    const key = target.closest<HTMLElement>("[data-sidebar-row]")?.dataset.sidebarRow;
    if (!key || !indexes.has(key)) return;
    const direction = event.key === "ArrowDown" || event.key === "Home" ? 1 : -1;
    let index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : (indexes.get(key) ?? 0) + direction;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    while (index >= 0 && index < rows.length && "label" in rows[index]) index += direction;
    if (index < 0 || index >= rows.length) return;
    event.preventDefault();
    event.stopPropagation();
    pendingFocus.current = rows[index].key;
    setFocusedKey(rows[index].key);
    virtualizer.scrollToIndex(index, { align: "auto" });
  };
  return (
    <div
      ref={root}
      data-testid="sidebar-virtual-history"
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
      onKeyDownCapture={navigate}
      onFocusCapture={(event) => {
        const key = (event.target as HTMLElement).closest<HTMLElement>("[data-sidebar-row]")
          ?.dataset.sidebarRow;
        if (key) setFocusedKey(key);
      }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        return (
          <div
            key={row.key}
            id={rowId(row.key)}
            data-sidebar-row={row.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${item.start - margin}px)` }}
          >
            {"label" in row ? (
              <p className="px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground/80">
                {getSidebarLabel(row.label)}
              </p>
            ) : (
              renderConversation(row.conversation)
            )}
          </div>
        );
      })}
    </div>
  );
}
