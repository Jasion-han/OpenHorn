// Conversation titles used to bake a " MM-DD HH:mm" timestamp into the title string
// (both the auto-generated titles and the "新会话 …" default). Titles are now kept
// clean and the time is surfaced separately in the chat header. These helpers keep the
// UI consistent: they strip the legacy suffix on display and still recognise the default
// title regardless of whether it carries the old timestamp.

export const DEFAULT_CONVERSATION_TITLE = "新会话";

const TITLE_TIMESTAMP_SUFFIX = / \d{2}-\d{2} \d{2}:\d{2}$/;

/** Strip the legacy " MM-DD HH:mm" suffix so old conversations render without a time. */
export function displayConversationTitle(title: string): string {
  const stripped = title.replace(TITLE_TIMESTAMP_SUFFIX, "").trim();
  return stripped || title.trim();
}

/** True for both the new "新会话" and the legacy "新会话 MM-DD HH:mm" default titles. */
export function isDefaultConversationTitle(title: string): boolean {
  return /^新会话( \d{2}-\d{2} \d{2}:\d{2})?$/.test(title.trim());
}

/** "MM-DD HH:mm" — the format previously appended to titles, now shown standalone. */
export function formatConversationTime(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}
