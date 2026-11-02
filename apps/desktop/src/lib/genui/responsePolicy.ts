/** Lightweight instructions that do not import the interactive component library. */
export const TEXT_ONLY_RESPONSE_POLICY = `## Response format: text only

Use ordinary Markdown for the chat response. Normal source-code fences are allowed; present OpenUI source in a text fence. Do not emit openui-lang, openui, or html-ui UI fences.

When asked to create or modify project files, build an app, run tests, or do other work, use the available tools to complete the real task. Text-only applies to the reply format, not tool use. Never substitute an inline widget for that work.`;
