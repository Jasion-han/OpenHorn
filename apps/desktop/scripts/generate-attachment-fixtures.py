"""Synthetic fixtures; requires Pillow, python-docx, openpyxl, python-pptx, pypdf, ffmpeg.
HEIC conversion uses macOS sips; unavailable image encoders are recorded as skipped.
"""
import hashlib
import json
import subprocess
import sys
import tempfile
import wave
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from pptx.util import Inches
from pypdf import PdfReader, PdfWriter

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="openhorn-attachment-matrix-"))
root.mkdir(parents=True, exist_ok=True)
items = []
skipped = []


def add(name, mime, kind, expected="preview", external=True, text=None):
    data = (root / name).read_bytes()
    items.append(dict(name=name, mime=mime, kind=kind, expected=expected, external=external,
                      size=len(data), sha256=hashlib.sha256(data).hexdigest(), text=text))


def write_text(name, content, mime="text/plain", encoding="utf-8", kind="text", external=True):
    (root / name).write_bytes(content.encode(encoding))
    add(name, mime, kind, external=external, text=content)


write_text("中文笔记.txt", "首行：附件验收\noriginal needle 内容\n末行：保持原文\n")
write_text("utf16.txt", "首行：UTF16\nneedle 中文内容\n末行\n", encoding="utf-16")
write_text("example.ts", "export const value: number = 42;\n", "application/octet-stream", external=False)
write_text("data.json", '{"name":"中文","value":42}\n', "application/json")
write_text("table.csv", 'name,value\n"中文",42\n', "text/csv")
write_text("settings.yaml", "name: attachment\nvalue: 42\n", "application/octet-stream", external=False)
write_text("page.html", "<h1>Original source</h1><script>window.attachmentInjected=true</script>\n", "text/html", external=False)
write_text("README.md", "# Attachment heading\n\n**Original Markdown**\n\n- one\n- two\n", "text/markdown", kind="markdown")

image = Image.new("RGB", (160, 100), "#e9f5f4")
ImageDraw.Draw(image).rectangle((20, 20, 140, 80), fill="#37a5aa")
for ext, fmt, mime in [("png", "PNG", "image/png"), ("jpg", "JPEG", "image/jpeg"), ("webp", "WEBP", "image/webp"), ("bmp", "BMP", "image/bmp"), ("tiff", "TIFF", "image/tiff")]:
    image.save(root / f"picture.{ext}", fmt)
    add(f"picture.{ext}", mime, "image", "fallback" if ext == "tiff" else "preview")
image.save(root / "动画.gif", save_all=True, append_images=[Image.new("RGB", (160, 100), "#b39c67")], duration=250, loop=0)
add("动画.gif", "image/gif", "image")
(root / "generic.PNG").write_bytes((root / "picture.png").read_bytes())
add("generic.PNG", "application/octet-stream", "image")
(root / "picture.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#37a5aa"/></svg>')
add("picture.svg", "image/svg+xml", "image", external=False)
try:
    image.save(root / "picture.avif", "AVIF")
    add("picture.avif", "image/avif", "image", external=False)
except Exception as error:
    skipped.append(dict(name="AVIF", reason=str(error)))
try:
    subprocess.run(["sips", "-s", "format", "heic", str(root / "picture.png"), "--out", str(root / "picture.heic")], check=True, capture_output=True)
    add("picture.heic", "image/heic", "image", "fallback")
except Exception as error:
    skipped.append(dict(name="HEIC", reason=str(error)))

# Standards-compliant, searchable two-page PDF, checked by an independent reader.
objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>", "", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
for index, content in [(3, "First original page"), (5, "Second needle page")]:
    stream = f"BT /F1 18 Tf 30 200 Td ({content}) Tj ET"
    objects[index] = f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream"
pdf, offsets = "%PDF-1.4\n", [0]
for index, obj in enumerate(objects):
    offsets.append(len(pdf))
    pdf += f"{index + 1} 0 obj\n{obj}\nendobj\n"
xref = len(pdf)
pdf += "xref\n0 8\n0000000000 65535 f \n" + "".join(f"{offset:010d} 00000 n \n" for offset in offsets[1:]) + f"trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF"
(root / "document.pdf").write_text(pdf)
reader = PdfReader(root / "document.pdf")
assert len(reader.pages) == 2 and "needle" in reader.pages[1].extract_text()
add("document.pdf", "application/pdf", "pdf")
protected = PdfWriter()
for page in reader.pages:
    protected.add_page(page)
protected.encrypt("fixture-password")
protected.write(root / "encrypted.pdf")
add("encrypted.pdf", "application/pdf", "pdf", "error")

with wave.open(str(root / "audio.wav"), "wb") as audio:
    audio.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
    audio.writeframes(bytes(16000 * 2 * 2))
add("audio.wav", "audio/wav", "audio")
for ext, mime, codec in [("mp3", "audio/mpeg", "libmp3lame"), ("m4a", "audio/mp4", "aac"), ("flac", "audio/flac", "flac"), ("ogg", "audio/ogg", "libopus")]:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(root / "audio.wav"), "-c:a", codec, str(root / f"audio.{ext}")], check=True)
    add(f"audio.{ext}", mime, "audio")
for ext, mime, codec in [("mp4", "video/mp4", "libx264"), ("webm", "video/webm", "libvpx-vp9"), ("mov", "video/quicktime", "libx264")]:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12:duration=2", "-an", "-c:v", codec, "-pix_fmt", "yuv420p", str(root / f"video.{ext}")], check=True)
    add(f"video.{ext}", mime, "video")

doc = Document()
doc.add_heading("Attachment acceptance", 0)
doc.add_paragraph("Original DOCX fixture, no real user data.")
doc.save(root / "document.docx")
assert "Original DOCX" in Document(root / "document.docx").paragraphs[1].text
add("document.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "file", "unsupported")
wb = Workbook()
wb.active.append(["item", "amount"])
wb.active.append(["fixture", 42])
wb.save(root / "workbook.xlsx")
add("workbook.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "file", "unsupported")
presentation = Presentation()
slide = presentation.slides.add_slide(presentation.slide_layouts[5])
slide.shapes.title.text = "Attachment acceptance"
slide.shapes.add_textbox(Inches(1), Inches(2), Inches(6), Inches(1)).text_frame.text = "Original PPTX fixture"
presentation.save(root / "slides.pptx")
add("slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "file", "unsupported")
with zipfile.ZipFile(root / "archive.zip", "w") as archive:
    archive.writestr("readme.txt", "Original ZIP fixture")
add("archive.zip", "application/zip", "file", "unsupported", external=False)
for name in ["document.docx", "workbook.xlsx", "slides.pptx", "archive.zip"]:
    with zipfile.ZipFile(root / name) as archive:
        assert archive.testzip() is None
for name, mime, kind in [("broken.png", "image/png", "image"), ("broken.pdf", "application/pdf", "pdf"), ("broken.mp4", "video/mp4", "video")]:
    (root / name).write_bytes(b"Deliberately invalid attachment fixture")
    add(name, mime, kind, "error")
(root / "manifest.json").write_text(json.dumps(dict(files=items, skipped=skipped), ensure_ascii=False, indent=2))
print(json.dumps(dict(root=str(root), files=len(items), skipped=skipped), ensure_ascii=False))
