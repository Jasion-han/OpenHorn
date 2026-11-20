import type { LibrarySource } from "shared/types";

export type OpenLibraryCitation = (source: LibrarySource, trigger: HTMLButtonElement) => void;
export type LibraryMarkdownCitations = {
  sources: LibrarySource[];
  open: OpenLibraryCitation;
};

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName: string; hProperties: Record<string, number> };
};

const literalContainers = new Set([
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
]);
const marker =
  /(\[|【)(?:source|来源)[ \t]*([1-9]\d*)(?:[ \t]*[:：][ \t]*([^\r\n]+?)[ \t]*[,，][ \t]*(?:chunk|片段)[ \t]*([1-9]\d*))?[ \t]*(\]|】)/giu;

export function remarkLibraryCitations(sources: LibrarySource[]) {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children || literalContainers.has(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) {
          visit(child);
          return [child];
        }
        const parts: MarkdownNode[] = [];
        let start = 0;
        for (const match of child.value.matchAll(marker)) {
          const [text, open, number, fileName, chunk, close] = match;
          if ((open === "[") !== (close === "]")) continue;
          const source = sources[Number(number) - 1];
          if (!source) continue;
          if (
            fileName !== undefined &&
            (fileName.trim() !== source.fileName || Number(chunk) !== source.chunkIndex + 1)
          )
            continue;
          if (start < match.index)
            parts.push({ type: "text", value: child.value.slice(start, match.index) });
          parts.push({
            type: "emphasis",
            children: [{ type: "text", value: text }],
            data: { hName: "span", hProperties: { "data-library-citation": Number(number) } },
          });
          start = match.index + text.length;
        }
        if (!parts.length) return [child];
        if (start < child.value.length)
          parts.push({ type: "text", value: child.value.slice(start) });
        return parts;
      });
    };
    visit(tree);
  };
}
