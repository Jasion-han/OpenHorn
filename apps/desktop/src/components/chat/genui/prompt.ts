import {
  HTML_UI_SECTION,
  OPENUI_EXAMPLES,
  OPENUI_RULES,
  PREAMBLE,
} from "../../../lib/genui/promptText";
import { genUiLibrary } from "./library";

/**
 * The system-prompt section that teaches a model to answer with interactive
 * UI. Appended only when the user turns "Interactive" on: it costs several
 * thousand tokens. Two tiers, chosen by the model per answer:
 *
 * 1. ```openui-lang — the component library below (constrained, themed,
 *    computes with its own $variables, no further model call).
 * 2. ```html-ui — a sandboxed HTML page for what components cannot express.
 *
 * Plain Markdown stays the default; UI is for answers the user will operate.
 */

let cached: string | null = null;

export function buildGenUiSystemPrompt(): string {
  if (cached) return cached;
  const openui = genUiLibrary.prompt({
    preamble: PREAMBLE,
    additionalRules: OPENUI_RULES,
    examples: OPENUI_EXAMPLES,
    bindings: true,
    builtinFunctions: true,
  });
  cached = `${openui}\n\n${HTML_UI_SECTION}`;
  return cached;
}
