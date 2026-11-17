import { expect, test } from "bun:test";
import { DocumentInputError } from "./documentInput";
import { readDocumentInput, saveDocumentInput } from "./documentInputCache";

for (const operation of ["save", "read"] as const)
  test(`blocked IndexedDB ${operation} produces a recoverable document_cache error`, async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: {
        open() {
          throw new DOMException("Synthetic storage denial", "SecurityError");
        },
      },
    });
    let failure: unknown;
    try {
      if (operation === "save")
        await saveDocumentInput("synthetic", [
          { kind: "file", fileName: "test.pdf", mediaType: "application/pdf", text: "Text" },
        ]);
      else await readDocumentInput("synthetic", "missing");
    } catch (error) {
      failure = error;
    } finally {
      if (original) Object.defineProperty(globalThis, "indexedDB", original);
      else Reflect.deleteProperty(globalThis, "indexedDB");
    }
    expect(failure instanceof DocumentInputError && failure.code === "document_cache").toBe(true);
  });
