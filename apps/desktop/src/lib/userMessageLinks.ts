import LinkifyIt from "linkify-it";

export type UserMessageLink = { start: number; end: number; url: string };
const parser = new LinkifyIt().set({ fuzzyEmail: false, fuzzyLink: false });

/** URL spans only; callers render untouched source slices around each span. */
export function findUserMessageLinks(text: string): UserMessageLink[] {
  const result: UserMessageLink[] = [];
  // Chinese prose need not put spaces before URLs. Sentence punctuation is a
  // boundary, while Chinese hostnames/path segments remain valid URL content.
  const candidates = /https?:\/\/[^\s<>"'`\p{Cc}，。；：！？、…“”‘’《》「」【】（）]+/giu;
  for (let match = candidates.exec(text); match; match = candidates.exec(text)) {
    let candidate = match[0].split(/,(?=https?:\/\/)/i, 1)[0];
    // A pasted numeric forum/article ID can be glued to prose without a space.
    // Restrict this recovery to an ASCII URL followed by a prose introducer;
    // ordinary Chinese paths (including /123资料) keep their complete spelling.
    const glued =
      /^(https?:\/\/[\x21-\x7e]*\/\d+)(?=(?:目前|现在|请问|我想|我还|我没|然后|但是|这个|这些)[\u3400-\u9fff]{2})/i.exec(
        candidate,
      );
    if (glued) candidate = glued[1];
    const found = parser.matchAtStart(candidate);
    if (!found) continue;
    try {
      const url = new URL(found.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      const end = match.index + found.lastIndex;
      result.push({ start: match.index, end, url: url.href });
      candidates.lastIndex = end;
    } catch {
      /* Invalid/incomplete URLs remain ordinary user text. */
    }
  }
  return result;
}
