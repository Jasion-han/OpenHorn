import { describe, expect, test } from "bun:test";
import {
  classifyReferenceHref,
  fileBasename,
  isTextLikePath,
  languageForPath,
  parseFileReference,
  referenceUrlTransform,
} from "./referenceLink";

describe("classifyReferenceHref", () => {
  test("http(s) urls are web", () => {
    expect(classifyReferenceHref("https://example.com/docs?x=1")).toEqual({
      kind: "web",
      url: "https://example.com/docs?x=1",
    });
    expect(classifyReferenceHref("http://localhost:3000/api")).toEqual({
      kind: "web",
      url: "http://localhost:3000/api",
    });
  });

  test("mailto / tel and unknown schemes go external", () => {
    expect(classifyReferenceHref("mailto:a@b.co")).toEqual({
      kind: "external",
      url: "mailto:a@b.co",
    });
    expect(classifyReferenceHref("tel:+8613800000000")).toEqual({
      kind: "external",
      url: "tel:+8613800000000",
    });
    expect(classifyReferenceHref("vscode://file/x")).toEqual({
      kind: "external",
      url: "vscode://file/x",
    });
  });

  test("file:// is a file with the scheme stripped", () => {
    expect(classifyReferenceHref("file:///Users/han/p/src/a.ts:12")).toEqual({
      kind: "file",
      path: "/Users/han/p/src/a.ts",
      line: 12,
    });
  });

  test("in-document anchors and empty hrefs are ignored", () => {
    expect(classifyReferenceHref("#section")).toEqual({ kind: "anchor" });
    expect(classifyReferenceHref("")).toEqual({ kind: "anchor" });
    expect(classifyReferenceHref(undefined)).toEqual({ kind: "anchor" });
  });

  test("bare domains become https web links", () => {
    expect(classifyReferenceHref("www.example.com/path")).toEqual({
      kind: "web",
      url: "https://www.example.com/path",
    });
    expect(classifyReferenceHref("docs.langchain.dev/oss")).toEqual({
      kind: "web",
      url: "https://docs.langchain.dev/oss",
    });
    expect(classifyReferenceHref("example.com")).toEqual({
      kind: "web",
      url: "https://example.com",
    });
  });

  test("file-looking names are not mistaken for domains", () => {
    expect(classifyReferenceHref("CODE_MAP.md")).toEqual({ kind: "file", path: "CODE_MAP.md" });
    expect(classifyReferenceHref("README.md")).toEqual({ kind: "file", path: "README.md" });
    expect(classifyReferenceHref("apps/web/README.md")).toEqual({
      kind: "file",
      path: "apps/web/README.md",
    });
    expect(classifyReferenceHref("www.x.y")).toEqual({ kind: "web", url: "https://www.x.y" });
    expect(classifyReferenceHref("route.ts:144")).toEqual({
      kind: "file",
      path: "route.ts",
      line: 144,
    });
    expect(classifyReferenceHref("package.json")).toEqual({ kind: "file", path: "package.json" });
  });

  test("real sample: href start line + text range → merged range", () => {
    expect(
      classifyReferenceHref(
        "apps/web/src/app/api/sync/landing-page/route.ts:144",
        "route.ts:144-149",
      ),
    ).toEqual({
      kind: "file",
      path: "apps/web/src/app/api/sync/landing-page/route.ts",
      line: 144,
      endLine: 149,
    });
  });

  test("href range wins over the link text", () => {
    expect(classifyReferenceHref("src/a.ts:10-20", "a.ts:30-40")).toEqual({
      kind: "file",
      path: "src/a.ts",
      line: 10,
      endLine: 20,
    });
  });

  test("text range only applies when the basename matches", () => {
    expect(classifyReferenceHref("src/a.ts", "b.ts:5-9")).toEqual({
      kind: "file",
      path: "src/a.ts",
    });
    expect(classifyReferenceHref("src/a.ts", "a.ts:5-9")).toEqual({
      kind: "file",
      path: "src/a.ts",
      line: 5,
      endLine: 9,
    });
  });

  test("supports :line, :line-end, :line:col and #L forms", () => {
    expect(classifyReferenceHref("src/a.ts:39")).toMatchObject({ path: "src/a.ts", line: 39 });
    expect(classifyReferenceHref("src/a.ts:39-69")).toMatchObject({
      path: "src/a.ts",
      line: 39,
      endLine: 69,
    });
    expect(classifyReferenceHref("src/a.ts:39:12")).toEqual({
      kind: "file",
      path: "src/a.ts",
      line: 39,
    });
    expect(classifyReferenceHref("src/a.ts#L39")).toEqual({
      kind: "file",
      path: "src/a.ts",
      line: 39,
    });
    expect(classifyReferenceHref("src/a.ts#L39-L69")).toEqual({
      kind: "file",
      path: "src/a.ts",
      line: 39,
      endLine: 69,
    });
  });

  test("an inverted range collapses to the start line", () => {
    expect(classifyReferenceHref("src/a.ts:50-10")).toEqual({
      kind: "file",
      path: "src/a.ts",
      line: 50,
    });
  });

  test("absolute paths under the workspace root become relative", () => {
    expect(classifyReferenceHref("/Users/han/p/src/a.ts:3", undefined, "/Users/han/p/")).toEqual({
      kind: "file",
      path: "src/a.ts",
      line: 3,
    });
    expect(classifyReferenceHref("/Users/han/p/src/a.ts", undefined, "/Users/han/p")).toEqual({
      kind: "file",
      path: "src/a.ts",
    });
  });

  test("absolute paths outside the workspace are passed through untouched", () => {
    expect(classifyReferenceHref("/etc/hosts", undefined, "/Users/han/p")).toEqual({
      kind: "file",
      path: "/etc/hosts",
    });
    expect(classifyReferenceHref("/oss/python/langchain/models")).toEqual({
      kind: "file",
      path: "/oss/python/langchain/models",
    });
  });

  test("leading ./ is dropped and percent-encoding decoded", () => {
    expect(classifyReferenceHref("./src/a.ts")).toEqual({ kind: "file", path: "src/a.ts" });
    expect(classifyReferenceHref("docs/%E8%AF%B4%E6%98%8E.md")).toEqual({
      kind: "file",
      path: "docs/说明.md",
    });
  });

  test("falls back to the link text when react-markdown blanked the href", () => {
    expect(classifyReferenceHref("", "route.ts:144-149")).toEqual({
      kind: "file",
      path: "route.ts",
      line: 144,
      endLine: 149,
    });
  });
});

describe("parseFileReference", () => {
  test("returns the path alone when there is no range", () => {
    expect(parseFileReference("src/a.ts")).toEqual({ path: "src/a.ts" });
  });
});

describe("referenceUrlTransform", () => {
  test("keeps http, mailto and relative hrefs like the default", () => {
    expect(referenceUrlTransform("https://a.com")).toBe("https://a.com");
    expect(referenceUrlTransform("mailto:a@b.co")).toBe("mailto:a@b.co");
    expect(referenceUrlTransform("apps/x/route.ts:144")).toBe("apps/x/route.ts:144");
  });

  test("keeps bare file:line references and file:// urls the default would blank", () => {
    expect(referenceUrlTransform("route.ts:144")).toBe("route.ts:144");
    expect(referenceUrlTransform("file:///tmp/a.ts")).toBe("file:///tmp/a.ts");
  });

  test("still blanks javascript: / data: urls, even with a leading digit", () => {
    expect(referenceUrlTransform("javascript:alert(1)")).toBe("");
    expect(referenceUrlTransform("javascript:1;alert(1)")).toBe("");
    expect(referenceUrlTransform("data:text/html,<script>alert(1)</script>")).toBe("");
    expect(referenceUrlTransform("vbscript:1")).toBe("");
  });

  test("keeps every line-range shape the classifier understands", () => {
    expect(referenceUrlTransform("src/a.ts:39-69")).toBe("src/a.ts:39-69");
    expect(referenceUrlTransform("src/a.ts:39:12")).toBe("src/a.ts:39:12");
    expect(referenceUrlTransform("src/a.ts:39-69:12")).toBe("src/a.ts:39-69:12");
  });
});

describe("languageForPath", () => {
  test("maps extensions and special filenames", () => {
    expect(languageForPath("src/a.tsx")).toBe("tsx");
    expect(languageForPath("src/a.ts")).toBe("typescript");
    expect(languageForPath("Dockerfile")).toBe("docker");
    expect(languageForPath("infra/Makefile")).toBe("makefile");
    expect(languageForPath(".env.local")).toBe("bash");
    expect(languageForPath("README")).toBe("text");
    expect(languageForPath("x.unknownext")).toBe("text");
  });
});

describe("isTextLikePath", () => {
  test("anything with a Prism language is text-like", () => {
    expect(isTextLikePath("src/a.ts")).toBe(true);
    expect(isTextLikePath("Dockerfile")).toBe(true);
    expect(isTextLikePath(".env.local")).toBe(true);
    expect(isTextLikePath("docs/README.md")).toBe(true);
  });

  test("plain text formats and config files without a Prism language are text-like", () => {
    expect(isTextLikePath("notes.txt")).toBe(true);
    expect(isTextLikePath("logs/app.log")).toBe(true);
    expect(isTextLikePath("data.csv")).toBe(true);
    expect(isTextLikePath("pnpm-lock.yaml")).toBe(true);
    expect(isTextLikePath("bun.lock")).toBe(true);
    expect(isTextLikePath("LICENSE")).toBe(true);
    expect(isTextLikePath("README")).toBe(true);
    expect(isTextLikePath(".editorconfig")).toBe(true);
    expect(isTextLikePath(".nvmrc")).toBe(true);
    expect(isTextLikePath(".prettierrc")).toBe(true);
    expect(isTextLikePath(".zshrc")).toBe(true);
    expect(isTextLikePath("CMakeLists.txt")).toBe(true);
  });

  test("images, documents, media, archives and unknown binaries are not", () => {
    expect(isTextLikePath("assets/logo.png")).toBe(false);
    expect(isTextLikePath("photo.JPG")).toBe(false);
    expect(isTextLikePath("spec.pdf")).toBe(false);
    expect(isTextLikePath("clip.mp4")).toBe(false);
    expect(isTextLikePath("song.mp3")).toBe(false);
    expect(isTextLikePath("bundle.zip")).toBe(false);
    expect(isTextLikePath("report.docx")).toBe(false);
    expect(isTextLikePath("sheet.xlsx")).toBe(false);
    expect(isTextLikePath("data/openhorn.db")).toBe(false);
    expect(isTextLikePath("bin/tool")).toBe(false);
    expect(isTextLikePath(".DS_Store")).toBe(false);
  });
});

describe("fileBasename", () => {
  test("fileBasename", () => {
    expect(fileBasename("apps/web/route.ts")).toBe("route.ts");
    expect(fileBasename("route.ts")).toBe("route.ts");
  });
});
