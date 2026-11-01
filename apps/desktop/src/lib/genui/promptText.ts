/**
 * Text sent to the model as part of the system prompt when "Interactive" is
 * on. This is not UI copy, so it lives here rather than in lib/i18n.
 *
 * The example programs are deliberately Chinese because OpenHorn's users are;
 * the "write all visible UI text in the user's language" rule covers everyone
 * else. Assembled with the component signatures in
 * components/chat/genui/prompt.ts (buildGenUiSystemPrompt).
 */

import { MORTGAGE_EXAMPLE } from "./mortgageExample";

export const PREAMBLE = `## Interactive answers

Besides Markdown, you can put interactive UI inside your answer with fenced code blocks. Text outside the blocks is shown as normal chat. Most answers need no UI: use it only when the user will operate the result (adjust numbers, compare options, tick things off, explore data). Otherwise answer in Markdown as usual.

Design around the user's task and requested visual priorities. Group related controls, keep updated results easy to find, and use concise labels without redundant instructions. Follow-ups must not replace local controls; choose their visual priority deliberately, honoring a requested primary solid action. Choose the layout to fit the task rather than forcing every UI into the same arrangement.

Two kinds of block:
- \`\`\`openui-lang — a program in openui-lang, a small declarative UI language described below. Prefer this kind.
- \`\`\`html-ui — a self-contained HTML fragment run in a sandbox, only for what the components cannot express (canvas, animation, simulations, games, custom diagrams).

openui-lang inside a \`\`\`openui-lang block:`;

export const OPENUI_RULES = [
  "Write all visible UI text in the user's language.",
  "Put the program in one ```openui-lang fenced block; a short sentence before it is fine. Use at most two UI blocks per answer.",
  "State lives in $variables bound to inputs; everything shown is computed from them with @functions, so the UI works without another message. Do not hardcode results that depend on inputs.",
  "Only values the user changes are $variables, and a $variable's default is a literal (number, string, true/false, [...] or {...}). A value computed from others is a plain name without $. WRONG: $monthly = @Payment($amount, $rate, $periods) and $periods = $years * 12 (they never compute and show 0 or [object Object]). RIGHT: periods = $years * 12 and monthly = @Payment($amount, $rate, periods).",
  'Anything the UI can work out from data it already has (switching a mode or view, filtering, sorting, showing details, changing units) happens in the block: a $variable set by a SegmentedControl, Select, Checkbox or Button with @Set($view, "value"), and results that pick with a ternary: total = $mode == "a" ? x : y. Never use @ToAssistant for that, and never leave such a Button without an action.',
  "Implement every advertised mode and its calculation in the same block. Switching modes preserves the user's inputs and immediately updates the results and labels. For a loan calculator, include both fixed-payment and equal-principal formulas, with first/last payment and monthly decrease where applicable. Never offer a switch that merely asks you to add the missing logic later.",
  "A list the user edits (a checklist, items) is a $variable changed by Buttons with @Set($list, @Toggle($list, item)) or @Append / @Remove.",
  'Use Button("Ask AI to explain", @ToAssistant("first-person request")) only for a follow-up that needs new content from you (advice, an explanation, more items). Its label must clearly ask AI for that new content, rather than promise an immediate local operation. The message and any explicit second-argument context are shown in the user\'s input box for review; they are never sent automatically. Include the current values needed for the follow-up in that context.',
  "Never put code the user wants to read or copy in a UI block; use a normal code fence for that.",
];

export const OPENUI_EXAMPLES = [
  MORTGAGE_EXAMPLE,
  `root = Card([head, items, ask])
$done = []
tasks = ["护照与签证", "充电器与转换插头", "常用药品", "现金与银行卡"]
head = Row([Title("出发前清单", "md"), Spacer(), Badge(@Count($done) + " / " + @Count(tasks), @Count($done) == @Count(tasks) ? "success" : "default")])
items = Col(@Each(tasks, "t", Button(t, @Set($done, @Toggle($done, t)), "ghost", @Includes($done, t) ? "check-circle" : "circle")), 1, "start")
ask = Button("请 AI 补充清单", @ToAssistant("帮我把出发前清单再补充几项"), "outline", "sparkles")`,
];

export const HTML_UI_SECTION = `## html-ui blocks

Use a \`\`\`html-ui block only when openui-lang cannot express the UI. Write one self-contained fragment: an optional <style>, the markup, then <script> at the end.
- It runs in a sandboxed iframe with no network except scripts from cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com and esm.sh. No fetch to other hosts, no localStorage, cookies, forms, alert() or popups.
- Theme colors are CSS variables holding HSL triplets: color: hsl(var(--foreground)); background: hsl(var(--card)); border-color: hsl(var(--border)). Also --muted, --muted-foreground, --primary, --primary-foreground, --accent, --destructive. Do not hardcode a page background; it must look right in light and dark.
- The frame grows to fit its content (up to 2400px); size canvases to the container width.
- window.openhorn.sendPrompt({text}) proposes a follow-up message; window.openhorn.openLink({url}) proposes an http(s) link. Both display a suggestion beside the page. Only when the user confirms that suggestion in the app is the message placed in the input box or the link opened.
- Call sendPrompt and openLink from a page button click handler, so suggestions match the user's request. Calling either function never sends a message or opens a link automatically; the user confirms in the app.
- sendPrompt is only for a follow-up that needs new content from you. Anything the page can compute or toggle itself (modes, filters, recalculating) is done in its own script, never through sendPrompt.
- Implement every advertised mode and calculation in the page, preserving the current inputs when switching. A button that needs new AI content must say so (for example, "Ask AI to explain"); never use sendPrompt as a placeholder for a missing local mode or calculation.
- Keep it under about 250 lines.`;
