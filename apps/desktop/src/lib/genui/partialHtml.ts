// Adapted from CopilotKit's processPartialHtml (MIT): turns a half-streamed
// HTML fragment into something safe to show as a static preview.

/** All complete `<style>` blocks in the fragment, concatenated. */
export function extractCompleteStyles(html: string): string {
  const matches = html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi);
  return matches ? matches.join("") : "";
}

/**
 * Markup of a still-streaming fragment, without scripts or styles. Order
 * matters: the unfinished trailing tag goes first so a half-written
 * `<scr` cannot survive the script stripping below it.
 */
export function processPartialHtml(html: string): string {
  let result = html;
  result = result.replace(/<[^>]*$/, "");
  result = result.replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  result = result.replace(/<(style|script|head)\b[^>]*>[\s\S]*$/gi, "");
  result = result.replace(/&[a-zA-Z0-9#]*$/, "");

  const bodyMatch = result.match(/<body[^>]*>([\s\S]*)/i);
  if (bodyMatch) {
    result = bodyMatch[1] ?? "";
    result = result.replace(/<\/body>[\s\S]*/i, "");
  }
  return result;
}
