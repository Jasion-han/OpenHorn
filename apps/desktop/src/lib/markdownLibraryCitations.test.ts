import { expect, test } from "bun:test";
import { remarkLibraryCitations } from "./markdownLibraryCitations";

type Tree = Parameters<ReturnType<typeof remarkLibraryCitations>>[0];
const linkCitations = remarkLibraryCitations([
  { documentId: "quote", fileName: "quote.md", text: "Quote", chunkIndex: 5 },
  { documentId: "terms", fileName: "条款.md", text: "Terms", chunkIndex: 1 },
]);

function prose(value: string): Tree {
  return { type: "paragraph", children: [{ type: "text", value }] };
}

function linkedNumbers(value: Tree) {
  return value.children?.flatMap((node) => {
    const number = node.data?.hProperties["data-library-citation"];
    return number === undefined ? [] : [number];
  });
}

test("maps source numbering to this turn and checks detailed reference metadata", () => {
  const paragraph = prose(
    "[source 1: quote.md, chunk 6] 【来源 2：条款.md，片段 2】 [source 2] " +
      "[source 1: quote.md, chunk 1] [source 2: quote.md, chunk 6] [source 3]",
  );
  linkCitations(paragraph);
  expect(linkedNumbers(paragraph)).toEqual([1, 2, 2]);
  expect(paragraph.children?.at(-1)?.value).toBe(
    " [source 1: quote.md, chunk 1] [source 2: quote.md, chunk 6] [source 3]",
  );
});

test("citation text in a code span or existing link remains literal", () => {
  const inlineCode = { type: "inlineCode", value: "[source 1]" };
  const link = { type: "link", children: [{ type: "text", value: "[source 1]" }] };
  const paragraph = { type: "paragraph", children: [inlineCode, link] };
  linkCitations(paragraph);
  expect(paragraph).toEqual({ type: "paragraph", children: [inlineCode, link] });
  expect(link.children).toEqual([{ type: "text", value: "[source 1]" }]);
});
