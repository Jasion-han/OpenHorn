import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Textarea, TooltipProvider } from "ui";
import { DesktopComposer } from "../../src/components/chat/DesktopComposer";
import { useComposerTextarea } from "../../src/hooks/useComposerTextarea";
import "../../src/styles/globals.css";

function Fixture() {
  const [value, setValue] = useState("");
  const [welcome, setWelcome] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const welcomeRef = useRef<HTMLTextAreaElement>(null);
  useComposerTextarea({ fieldRef: welcomeRef, value: welcome, minHeight: 72, maxHeight: 200 });
  return (
    <main style={{ width: "min(600px, 90vw)", margin: "32px auto" }}>
      <DesktopComposer
        value={value}
        onChange={setValue}
        onKeyDown={() => {}}
        placeholderPool={["Composer"]}
        attachments={[]}
        disabled={false}
        onAddAttachments={() => {}}
        onRemoveAttachment={() => {}}
        mode="chat"
        onModeChange={() => {}}
        onSubmit={() => {
          throw new Error("Unexpected submit");
        }}
        forceWebSearch={false}
        onToggleWebSearch={() => {}}
        streaming={false}
        canSubmit={false}
        onStop={() => {}}
        inputRef={ref}
        slashHighlight={value.startsWith("/test") ? { start: 0, len: 5 } : null}
      />
      <Textarea
        aria-label="Welcome"
        ref={welcomeRef}
        value={welcome}
        rows={3}
        onChange={(e) => setWelcome(e.target.value)}
        className="min-h-[72px] max-h-[200px] resize-none border-0 bg-transparent p-0 pr-7 text-sm leading-5"
      />
    </main>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>,
  );
