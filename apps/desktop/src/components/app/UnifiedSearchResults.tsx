import type { UnifiedSearchKind, UnifiedSearchResult } from "shared/types";
import { getSidebarLabel as label, type SidebarLabelKey } from "../../lib/i18n/agent";

const groups: Record<UnifiedSearchKind, SidebarLabelKey> = {
  conversation: "sidebar.search.kind.conversation",
  message: "sidebar.search.kind.message",
  artifact: "sidebar.search.kind.artifact",
  recipe: "sidebar.search.kind.recipe",
  project: "sidebar.search.kind.project",
  reviews: "sidebar.search.kind.reviews",
  library: "sidebar.search.kind.library",
};
export function UnifiedSearchResults({
  results,
  onOpen,
}: {
  results: UnifiedSearchResult[];
  onOpen(result: UnifiedSearchResult): void;
}) {
  return (
    <div data-testid="unified-search-results">
      {Object.entries(groups).map(([kind, key]) => {
        const items = results.filter((item) => item.kind === kind);
        if (!items.length) return null;
        return (
          <section key={kind} aria-label={label(key)} className="space-y-1 py-2">
            <h3 className="px-3 text-xs font-medium text-muted-foreground">{label(key)}</h3>
            {items.map((item) => (
              <button
                key={`${item.kind}:${item.id}`}
                type="button"
                data-search-kind={item.kind}
                onClick={() => onOpen(item)}
                className="flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <span className="w-full truncate font-medium">
                  {item.title || label("sidebar.search.untitled")}
                </span>
                {item.snippet && (
                  <span className="line-clamp-2 text-xs text-muted-foreground">{item.snippet}</span>
                )}
              </button>
            ))}
          </section>
        );
      })}
      {Object.keys(groups).some(
        (kind) => results.filter((item) => item.kind === kind).length >= 8,
      ) && (
        <p className="px-3 py-2 text-xs text-muted-foreground">{label("sidebar.search.limit")}</p>
      )}
    </div>
  );
}
