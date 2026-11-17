import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { researchQuestion, withoutResearchCommand, withResearchCommand } from "shared/research";
import type { AttachmentPart } from "shared/types";
import { TooltipProvider } from "ui";
import { DesktopComposer } from "../src/components/chat/DesktopComposer";
import { filesToAttachmentParts } from "../src/lib/attachmentParts";
import { DocumentInputError, expandDocumentFiles } from "../src/lib/documentInput";
import { readDocumentInput, saveDocumentInput } from "../src/lib/documentInputCache";
import { getChatLabel } from "../src/lib/i18n/agent";
import { useAuthStore } from "../src/stores/authStore";
import { useDocumentInputStore } from "../src/stores/documentInputStore";
import "../src/styles/globals.css";

useAuthStore.setState({
  user: { id: "document-research-fixture", username: "Synthetic", email: "synthetic@test.invalid" },
  ready: true,
});
let captured: AttachmentPart[] = [];
const scope = JSON.stringify([location.origin, "document-research-fixture"]);
Object.assign(window, {
  documentResearch: {
    parts: () => captured,
    async recover(key: string, owner = scope) {
      return readDocumentInput(owner, key);
    },
    async save(parts: AttachmentPart[], owner = scope) {
      return saveDocumentInput(owner, parts);
    },
    owner: scope,
  },
});

function Fixture() {
  const [text, setText] = useState("Compare the charts"),
    [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<"chat" | "agent">("chat"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [vision, setVision] = useState(true),
    [key, setKey] = useState("");
  const controller = useRef<AbortController | null>(null);
  const prepare = async () => {
    controller.current = new AbortController();
    setBusy(true);
    setError("");
    try {
      const actualFiles = await expandDocumentFiles(
        files,
        (file) => useDocumentInputStore.getState().options.get(file),
        vision,
        controller.current.signal,
      );
      captured = await filesToAttachmentParts(actualFiles, controller.current.signal);
      setKey(await saveDocumentInput(scope, captured));
    } catch (cause) {
      setError(
        cause instanceof DocumentInputError
          ? getChatLabel(`chat.document.${cause.code}`)
          : "Stopped",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <TooltipProvider>
      <main className="mx-auto flex max-w-4xl flex-col gap-4 p-8">
        <h1 className="text-lg font-medium">OpenHorn · Synthetic document input fixture</h1>
        <button
          type="button"
          onClick={() => setVision((value) => !value)}
          className="self-start rounded border px-3 py-1"
        >
          {vision ? "Vision fixture" : "Text-only fixture"}
        </button>
        <DesktopComposer
          value={text}
          onChange={setText}
          onKeyDown={() => {}}
          placeholderPool={[]}
          attachments={files}
          disabled={false}
          onAddAttachments={(next) => setFiles((current) => [...current, ...next])}
          onRemoveAttachment={(file) =>
            setFiles((current) => current.filter((value) => value !== file))
          }
          mode={mode}
          onModeChange={(value) => {
            setMode(value);
            setText(withoutResearchCommand(text));
          }}
          onSubmit={() => void prepare()}
          modelLabel={vision ? "gpt-4o" : "text-only"}
          visionAvailable={vision}
          researchMode={researchQuestion(text) !== null}
          researchAvailable={vision}
          onResearch={() => {
            setMode("agent");
            setText(withResearchCommand(text));
          }}
          forceWebSearch
          streaming={busy}
          canSubmit={!busy && files.length > 0}
          onStop={() => controller.current?.abort()}
          onToggleWebSearch={() => {}}
        />
        <output data-testid="result">{key}</output>
        <p role="alert">{error}</p>
      </main>
    </TooltipProvider>
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
