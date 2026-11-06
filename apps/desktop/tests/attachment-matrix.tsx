import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DesktopAttachmentPreviewItem } from "../src/components/chat/DesktopAttachmentPreviewItem";
import { ACCEPT_FILES } from "../src/components/chat/DesktopComposer";
import { DesktopMessageAttachments } from "../src/components/chat/DesktopMessageAttachments";
import { DesktopPreviewPanel } from "../src/components/preview/DesktopPreviewPanel";
import { usePreviewPanelStore } from "../src/stores/previewPanelStore";
import "../src/styles/globals.css";
type Spec = { name: string; mime: string; id?: string };
function Fixture() {
  const [files, setFiles] = useState<File[]>([]);
  const [specs, setSpecs] = useState<Spec[]>([]);
  const panel = usePreviewPanelStore();
  useEffect(() => {
    void fetch("/__matrix/manifest.json")
      .then((r) => r.json())
      .then((result) => setSpecs(result.files));
  }, []);
  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <main style={{ flex: 1, minWidth: 0, overflow: "auto", padding: 16 }}>
        <input
          type="file"
          multiple
          aria-label="Fixture files"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        <output data-accept={ACCEPT_FILES}>Loaded {files.length}</output>
        <section aria-label="Composer files">
          {files.map((file) => (
            <DesktopAttachmentPreviewItem
              key={file.name}
              file={file}
              onRemove={() => setFiles((current) => current.filter((f) => f !== file))}
            />
          ))}
        </section>
        <section aria-label="Message files">
          {specs.map((spec) => (
            <DesktopMessageAttachments
              key={spec.name}
              attachments={[
                {
                  id: spec.id,
                  fileName: spec.name,
                  fileType: spec.mime,
                  previewUrl: spec.id
                    ? undefined
                    : `/__matrix/file/${encodeURIComponent(spec.name)}`,
                },
              ]}
            />
          ))}
        </section>
        <textarea aria-label="Chat draft" />
      </main>
      {panel.isOpen && <DesktopPreviewPanel collapsed={panel.collapsed} />}
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(<Fixture />);
