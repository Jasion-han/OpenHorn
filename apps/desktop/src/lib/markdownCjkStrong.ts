type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/** Repair CJK strong delimiters left as text by CommonMark's punctuation rules. */
export function remarkCjkStrong() {
  return (tree: MarkdownNode, file: { value?: unknown }) => {
    const source = typeof file.value === "string" ? file.value : "";
    const visit = (node: MarkdownNode) => {
      if (!node.children) return;
      const children: MarkdownNode[] = [];
      for (const child of node.children) {
        if (
          child.type !== "text" ||
          !child.value?.includes("**") ||
          (node.type === "link" && node.url === child.value)
        ) {
          visit(child);
          children.push(child);
          continue;
        }
        const { start, end } = child.position ?? {};
        const raw = source.slice(start?.offset ?? 0, end?.offset ?? source.length);
        // Escaped stars express literal text. Code, HTML and link destinations
        // are different AST node types and never reach this repair path.
        if (raw.includes("\\*")) {
          children.push(child);
          continue;
        }
        const value = child.value;
        let offset = 0;
        for (const match of value.matchAll(/\*\*([^*\n]+)\*\*/g)) {
          const body = match[1].trim();
          if (
            !body ||
            !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(body)
          )
            continue;
          if (match.index > offset)
            children.push({ type: "text", value: value.slice(offset, match.index) });
          children.push({ type: "strong", children: [{ type: "text", value: body }] });
          offset = match.index + match[0].length;
        }
        if (!offset) children.push(child);
        else if (offset < value.length) children.push({ type: "text", value: value.slice(offset) });
      }
      node.children = children;
    };
    visit(tree);
  };
}
