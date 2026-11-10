import { expect, test } from "bun:test";
import { chunkText } from "./chunkingService";

for (const [name, text, fileName] of [
  ["single paragraph", "x".repeat(10_000), "long.txt"],
  ["paragraph after overlap", `short paragraph\n\n${"long word ".repeat(800)}`, "long.txt"],
  ["Markdown section", `# Heading\n${"x".repeat(10_000)}\n\n## Next\nend`, "long.md"],
] as const) {
  test(`bounds every chunk for ${name} without losing the final text`, () => {
    const chunks = chunkText(text, fileName);
    expect(chunks.length > 1).toBe(true);
    expect(chunks.every((chunk) => chunk.text.length <= 2800)).toBe(true);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
    expect(text.trim().endsWith(chunks.at(-1)?.text ?? "missing")).toBe(true);
    if (fileName === "long.md") {
      expect(chunks[0].heading).toBe("Heading");
      expect(chunks.at(-1)?.heading).toBe("Next");
    }
  });
}

test("preserves all content and bounded overlaps for a long indivisible token", () => {
  const text = Array.from({ length: 11_000 }, (_, index) =>
    String.fromCharCode(0x4e00 + index),
  ).join("");
  const chunks = chunkText(text, "long.txt");
  let rebuilt = chunks[0].text;
  for (let i = 1; i < chunks.length; i++) {
    const overlap = chunks[i - 1].text.slice(-200);
    expect(chunks[i].text.startsWith(overlap)).toBe(true);
    rebuilt += chunks[i].text.slice(200);
  }
  expect(rebuilt).toBe(text);
});

test("never splits a Unicode surrogate pair at chunk or overlap boundaries", () => {
  const text = `${"x".repeat(2799)}😀${"y".repeat(2400)}🚀${"z".repeat(4000)}`;
  const chunks = chunkText(text, "long.txt");
  expect(chunks.every((chunk) => chunk.text.length <= 2800)).toBe(true);
  expect(
    chunks.every((chunk) => Buffer.from(chunk.text, "utf8").toString("utf8") === chunk.text),
  ).toBe(true);
  expect(chunks.some((chunk) => chunk.text.includes("😀"))).toBe(true);
  expect(chunks.some((chunk) => chunk.text.includes("🚀"))).toBe(true);
});

test("paragraph and word boundary preferences preserve every source token", () => {
  const words = Array.from(
    { length: 1500 },
    (_, index) => `token-${index.toString().padStart(4, "0")}`,
  );
  const text = `${words.slice(0, 300).join(" ")}\n\n${words.slice(300, 700).join(" ")}\r\n\r\n${words.slice(700).join(" ")}`;
  const chunks = chunkText(text, "words.txt");
  expect(chunks.every((chunk) => chunk.text.length <= 2800)).toBe(true);
  const combined = chunks.map((chunk) => chunk.text).join("\n");
  expect(words.every((word) => combined.includes(word))).toBe(true);
  expect(chunkText(" \n\t")).toEqual([]);
  expect(chunkText("short text")).toEqual([{ index: 0, text: "short text" }]);
});
