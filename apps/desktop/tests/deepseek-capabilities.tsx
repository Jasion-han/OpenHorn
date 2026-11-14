import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { LibraryDocument } from "shared/types";
import { Button, TooltipProvider } from "ui";
import { DesktopCitationList } from "../src/components/chat/DesktopCitationList";
import { DesktopNativeWebActivity } from "../src/components/chat/DesktopNativeWebActivity";
import { LibraryOcrDialog } from "../src/components/library/LibraryOcrDialog";
import { DeepSeekToolSettings } from "../src/components/settings/DeepSeekToolSettings";
import { useAuthStore } from "../src/stores/authStore";
import "../src/styles/globals.css";

useAuthStore.setState({
  user: { id: "fixture-user", username: "Synthetic", email: "fixture@test.invalid" },
  ready: true,
});
const doc: LibraryDocument = {
  id: "ocr-synthetic",
  projectId: null,
  fileName: "Synthetic scan.pdf",
  fileType: "application/pdf",
  fileSize: 1234,
  status: "failed",
  errorCode: "library_empty_text",
  chunkCount: 0,
  revision: 1,
  canIndex: true,
  canOcr: true,
  createdAt: "2026-11-14T00:00:00Z",
  updatedAt: "2026-11-14T00:00:00Z",
};
const fixture = { ocrCalls: 0, failOcr: true };
Object.assign(window, { capabilityFixture: fixture });
function Fixture() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  return (
    <TooltipProvider>
      <main className="mx-auto max-w-3xl space-y-8 p-8 text-foreground">
        <DeepSeekToolSettings />
        <section
          aria-label="Native web fixture"
          className="rounded-xl border border-border bg-card p-4"
        >
          <DesktopNativeWebActivity
            metadata={{
              steps: [
                {
                  id: "search-1",
                  action: "search",
                  status: "completed",
                  query: "Synthetic official release",
                },
                {
                  id: "read-1",
                  action: "open_page",
                  status: "completed",
                  url: "https://example.com/source",
                  title: "Synthetic official source",
                },
              ],
              toolUsage: { search: 1, fetch: 1, imageSearch: 0 },
            }}
          />
          <p className="text-sm">Synthetic source-backed answer.</p>
          <DesktopCitationList
            citations={[
              {
                title: "Synthetic official source",
                url: "https://example.com/source",
                snippet: "Synthetic evidence only.",
              },
              { title: "Unsafe source", url: "javascript:alert(1)" },
            ]}
          />
        </section>
        <Button
          variant="outline"
          onClick={() => {
            setError("");
            setOpen(true);
          }}
        >
          Open OCR fixture
        </Button>
        {open && (
          <LibraryOcrDialog
            document={doc}
            errorMessage={error}
            onClose={() => setOpen(false)}
            onConfirm={async () => {
              fixture.ocrCalls++;
              if (fixture.failOcr) {
                setError("Synthetic OCR failure");
                return false;
              }
              return true;
            }}
          />
        )}
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
