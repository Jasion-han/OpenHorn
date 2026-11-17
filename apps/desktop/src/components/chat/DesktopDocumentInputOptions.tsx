import { fileKey } from "shared/format";
import { isPdfDocument } from "../../lib/documentInput";
import { getChatLabel as label } from "../../lib/i18n/agent";
import { useDocumentInputStore } from "../../stores/documentInputStore";

export function DesktopDocumentInputOptions({
  files,
  vision,
  disabled = false,
}: {
  files: File[];
  vision: boolean;
  disabled?: boolean;
}) {
  const { options } = useDocumentInputStore();
  const change = useDocumentInputStore((state) => state.set);
  const pdfs = files.filter(isPdfDocument);
  if (!pdfs.length) return null;
  return (
    <div className="space-y-2 px-[15px] pb-2 text-xs">
      {pdfs.map((file) => {
        const value = options.get(file) ?? { layout: false, pages: "" };
        return (
          <div
            key={fileKey(file)}
            className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-2"
          >
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={value.layout}
                disabled={disabled || (!vision && !value.layout)}
                onChange={(event) => change(file, { ...value, layout: event.target.checked })}
                className="accent-primary"
              />
              <span>
                {label("chat.document.layout")} · {file.name}
              </span>
            </label>
            {!vision ? (
              <p className="text-muted-foreground">{label("chat.document.vision")}</p>
            ) : value.layout ? (
              <>
                <label className="flex items-center gap-2">
                  <span>{label("chat.document.pages")}</span>
                  <input
                    className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={value.pages}
                    disabled={disabled}
                    placeholder={label("chat.document.range")}
                    onChange={(event) => change(file, { ...value, pages: event.target.value })}
                    maxLength={100}
                  />
                </label>
                <p className="text-muted-foreground">{label("chat.document.hint")}</p>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
