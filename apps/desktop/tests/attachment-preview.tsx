import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DesktopAttachmentPreviewItem } from "../src/components/chat/DesktopAttachmentPreviewItem";
import { DesktopMessageAttachments } from "../src/components/chat/DesktopMessageAttachments";
import { DesktopPreviewPanel } from "../src/components/preview/DesktopPreviewPanel";
import { usePreviewPanelStore } from "../src/stores/previewPanelStore";
import "../src/styles/globals.css";

function makePdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    "",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, text] of [
    [3, "First original page"],
    [5, "Second needle page"],
  ] as const) {
    const stream = `BT /F1 18 Tf 30 200 Td (${text}) Tj ET`;
    objects[index] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 8\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new File([pdf], "two-pages.pdf", { type: "application/pdf" });
}
function makeAudio() {
  const data = new Uint8Array(844);
  const view = new DataView(data.buffer);
  const text = (offset: number, value: string) => {
    for (let n = 0; n < value.length; n++) data[offset + n] = value.charCodeAt(n);
  };
  text(0, "RIFF");
  view.setUint32(4, 836, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, 800, true);
  data.fill(128, 44);
  return new File([data], "audio.wav", { type: "audio/wav" });
}
const files = [
  new File(["FIRST\nneedle one\nneedle two\nLAST"], "notes.txt", { type: "text/plain" }),
  new File(
    [
      "# Heading\n\n**Original**\n\n<img src='https://invalid.example/image.png' onerror='window.attachmentInjected=true'>\n\n![remote](https://invalid.example/a.png)",
    ],
    "README.md",
  ),
  new File(["<script>window.attachmentInjected=true</script>"], "page.html", { type: "text/html" }),
  new File(["original archive bytes"], "archive.zip"),
  new File([], "empty.txt"),
  new File(["a".repeat(2 * 1024 * 1024), "HIDDEN-END"], "large.txt"),
  new File(
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#37a5aa" /></svg>',
    ],
    "image.svg",
    { type: "image/svg+xml" },
  ),
  new File(
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="80" fill="#b39c67" /></svg>',
    ],
    "second.svg",
    { type: "image/svg+xml" },
  ),
  makePdf(),
  makeAudio(),
  new File(["invalid video"], "video.mp4", { type: "video/mp4" }),
];
const attachments = files.map((file) => ({
  fileName: file.name,
  fileType: file.type,
  fileSize: file.size,
  previewUrl: URL.createObjectURL(file),
}));
function Fixture() {
  const [removed, setRemoved] = useState(0);
  const open = usePreviewPanelStore((state) => state.isOpen);
  const collapsed = usePreviewPanelStore((state) => state.collapsed);
  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <main className="p-6" style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
        <textarea aria-label="Chat draft" className="rounded border p-2" />
        {open && collapsed && (
          <button type="button" onClick={() => usePreviewPanelStore.getState().expandPanel()}>
            Expand preview
          </button>
        )}
        <h1>Attachment fixture</h1>
        <p>removed: {removed}</p>
        <section aria-label="Composer">
          <DesktopAttachmentPreviewItem file={files[0]} onRemove={() => setRemoved((n) => n + 1)} />
        </section>
        <section aria-label="Messages">
          <DesktopMessageAttachments
            attachments={[
              ...attachments,
              { fileName: "old.txt" },
              { fileName: "auth.txt", id: "test-auth" },
            ]}
          />
        </section>
      </main>
      {open && <DesktopPreviewPanel collapsed={collapsed} />}
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
