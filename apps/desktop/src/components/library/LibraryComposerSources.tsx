import { LIBRARY_LIMITS } from "shared/library";
import type { LibrarySource } from "shared/types";
import { Checkbox } from "ui";
import { formatLibraryLabel as format } from "../../lib/i18n/agent";
import { librarySourceKey } from "../../lib/libraryChatDraft";
import { formatLibraryLocation } from "./LibrarySourceLocation";
import { useLibrarySourcePreview } from "./useLibrarySourcePreview";

export function LibraryComposerSources({
  id,
  sources,
  selection,
}: {
  id: string;
  sources: LibrarySource[];
  selection?: { keys: string[]; disabled: boolean; onChange(keys: string[]): void };
}) {
  const { open, dialog } = useLibrarySourcePreview();
  return (
    <>
      <section
        id={id}
        aria-label={format("library.composerSources", { count: sources.length })}
        className="rounded-md border border-stone-200 bg-stone-50 text-stone-900"
      >
        <ol className="max-h-52 divide-y divide-stone-200 overflow-auto px-3">
          {sources.map((source) => {
            const location =
              formatLibraryLocation(source.location) ||
              format("library.chunk", { number: source.chunkIndex + 1 });
            const key = selection ? librarySourceKey(source) : "";
            const checked = selection?.keys.includes(key) ?? false;
            return (
              <li key={`${source.documentId}:${source.chunkIndex}`} className="space-y-1 py-2">
                <div className="flex items-start gap-2.5">
                  {selection && (
                    <Checkbox
                      checked={checked}
                      disabled={
                        selection.disabled ||
                        (checked
                          ? selection.keys.length === 1
                          : selection.keys.length >= LIBRARY_LIMITS.sources)
                      }
                      aria-label={format("library.composerSourceInclude", {
                        file: source.fileName,
                        location,
                      })}
                      className="mt-0.5 border-stone-400 bg-white data-[state=checked]:border-amber-400 data-[state=checked]:bg-amber-100 data-[state=checked]:text-amber-950"
                      onCheckedChange={(next) =>
                        selection.onChange(
                          next === true
                            ? [...selection.keys, key]
                            : selection.keys.filter((value) => value !== key),
                        )
                      }
                    />
                  )}
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <button
                      type="button"
                      className="min-w-0 rounded-sm text-left text-sm font-medium underline decoration-stone-400 underline-offset-2 hover:bg-amber-100 hover:decoration-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
                      aria-label={format("library.openSourceOriginal", {
                        file: source.fileName,
                        location,
                      })}
                      onClick={(event) => open(source, event.currentTarget)}
                    >
                      <span className="break-words">{source.fileName}</span>
                    </button>
                    <span className="text-xs text-stone-600">{location}</span>
                  </div>
                </div>
                <p className="line-clamp-1 text-sm text-stone-600">{source.text}</p>
              </li>
            );
          })}
        </ol>
      </section>
      {dialog}
    </>
  );
}
