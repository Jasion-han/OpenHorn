/**
 * Text sent to the model as part of the system prompt when "Interactive" is
 * on. This is not UI copy, so it lives here rather than in lib/i18n.
 *
 * The example programs are deliberately Chinese because OpenHorn's users are;
 * the "write all visible UI text in the user's language" rule covers everyone
 * else. Assembled with the component signatures in
 * components/chat/genui/prompt.ts (buildGenUiSystemPrompt).
 */

export const PREAMBLE = `## Interactive answers

Besides Markdown, you can put interactive UI inside your answer with fenced code blocks. Text outside the blocks is shown as normal chat. Most answers need no UI: use it only when the user will operate the result (adjust numbers, compare options, tick things off, explore data). Otherwise answer in Markdown as usual.

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
  "A list the user edits (a checklist, items) is a $variable changed by Buttons with @Set($list, @Toggle($list, item)) or @Append / @Remove.",
  'Use Button("Label", @ToAssistant("first-person request")) only for a follow-up that needs new content from you (advice, an explanation, more items). The text is placed in the user\'s input box for them to send; it is never sent automatically.',
  "Never put code the user wants to read or copy in a UI block; use a normal code fence for that.",
];

export const OPENUI_EXAMPLES = [
  `root = Card([title, mode, inputs, result, chart, ask])
$mode = "等额本息"
$amount = 1000000
$rate = 3.5
$years = 30
title = Title("房贷月供计算", "md")
mode = SegmentedControl($mode, ["等额本息", "等额本金"], "还款方式")
inputs = Grid([Slider($amount, 100000, 5000000, 50000, "贷款金额", "¥"), Slider($rate, 1, 8, 0.05, "年利率", "%"), Slider($years, 5, 30, 1, "年限", "年")], 3, 180)
n = $years * 12
r = $rate / 1200
byPrincipal = $mode == "等额本金"
monthly = byPrincipal ? $amount / n + $amount * r : @Payment($amount, $rate, n)
interest = byPrincipal ? $amount * r * (n + 1) / 2 : monthly * n - $amount
result = Row([Stat(byPrincipal ? "首月还款" : "每月还款", @Format(monthly, "currency", 0), byPrincipal ? "之后每月少还 " + @Format($amount / n * r, "currency", 2) : null), Stat("总利息", @Format(interest, "currency", 0), null, "warning")], 6)
chart = Chart("pie", ["本金", "利息"], [{name: "构成", values: [$amount, interest]}], "¥")
ask = Button("结合我的收入评估压力", @ToAssistant("结合我的月收入，帮我评估这笔房贷的还款压力"), "outline", "sparkles")`,
  `root = Card([head, items, ask])
$done = []
tasks = ["护照与签证", "充电器与转换插头", "常用药品", "现金与银行卡"]
head = Row([Title("出发前清单", "md"), Spacer(), Badge(@Count($done) + " / " + @Count(tasks), @Count($done) == @Count(tasks) ? "success" : "default")])
items = Col(@Each(tasks, "t", Button(t, @Set($done, @Toggle($done, t)), "ghost", @Includes($done, t) ? "check-circle" : "circle")), 1, "start")
ask = Button("再帮我补充几项", @ToAssistant("帮我把出发前清单再补充几项"), "outline", "sparkles")`,
];

export const HTML_UI_SECTION = `## html-ui blocks

Use a \`\`\`html-ui block only when openui-lang cannot express the UI. Write one self-contained fragment: an optional <style>, the markup, then <script> at the end.
- It runs in a sandboxed iframe with no network except scripts from cdn.jsdelivr.net, unpkg.com, cdnjs.cloudflare.com and esm.sh. No fetch to other hosts, no localStorage, cookies, forms, alert() or popups.
- Theme colors are CSS variables holding HSL triplets: color: hsl(var(--foreground)); background: hsl(var(--card)); border-color: hsl(var(--border)). Also --muted, --muted-foreground, --primary, --primary-foreground, --accent, --destructive. Do not hardcode a page background; it must look right in light and dark.
- The frame grows to fit its content (up to 2400px); size canvases to the container width.
- window.openhorn.sendPrompt({text}) offers a follow-up message (placed in the input box for the user to send); window.openhorn.openLink({url}) opens an https link.
- Call sendPrompt and openLink only from a click handler: they are ignored unless the user is interacting with the frame, so calls made on load do nothing.
- sendPrompt is only for a follow-up that needs new content from you. Anything the page can compute or toggle itself (modes, filters, recalculating) is done in its own script, never through sendPrompt.
- Keep it under about 250 lines.`;
