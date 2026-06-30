/**
 * Heuristic vision-capability detection for model identifiers.
 *
 * Local-run agents (sidecar) have no provider metadata to query, so we rely on
 * a name-based allow-list. The list errs on the side of caution: when a model
 * id does not clearly match a known vision-capable family we return `false`,
 * so the runtime degrades an image to a text placeholder instead of sending
 * raw image bytes to a text-only endpoint (which would error).
 *
 * Matching is case-insensitive and substring-based — an id only needs to
 * *contain* one of the known markers to be treated as vision-capable.
 */

/**
 * Substrings that, when present in a model id, indicate vision support.
 * Kept lowercase; the input is lowercased before matching.
 */
const VISION_MODEL_MARKERS: readonly string[] = [
  // OpenAI
  "gpt-4o",
  "chatgpt-4o",
  "gpt-4.1",
  "gpt-4-turbo",
  "gpt-4-vision",
  "gpt-5",
  "o1",
  "o3",
  "o4",
  // Anthropic (Claude 3 and 4 families are all vision-capable)
  "claude-3",
  "claude-sonnet-4",
  "claude-opus-4",
  "claude-haiku-4",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  // Google
  "gemini",
  // Qwen vision variants
  "qwen-vl",
  "qwen2-vl",
  "qwen2.5-vl",
  "qwen-vl-max",
  "qwen-vl-plus",
  // Zhipu GLM vision
  "glm-4v",
  "glm-4.1v",
  // ByteDance Doubao vision
  "doubao-vision",
  "doubao-1-5-vision",
  // Open-weight vision families
  "llava",
  "pixtral",
  "internvl",
  "minicpm-v",
  "step-1v",
  "yi-vision",
];

/**
 * Markers that explicitly indicate a NON-vision model, taking precedence over
 * the allow-list. Guards against false positives where a vision substring is a
 * prefix of a text-only id (e.g. `o1`/`o3`/`o4` accidentally matching some
 * unrelated token). These are checked first.
 */
const NON_VISION_MODEL_MARKERS: readonly string[] = [
  "deepseek-chat",
  "deepseek-reasoner",
  "deepseek-coder",
  "gpt-3.5",
  "text-",
];

/**
 * Returns true when the given model id is heuristically known to accept image
 * input. Unknown ids return false (conservative — prefer text fallback over a
 * vision request that errors on text-only models).
 */
export function modelSupportsVision(modelId: string): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();

  for (const marker of NON_VISION_MODEL_MARKERS) {
    if (id.includes(marker)) return false;
  }

  for (const marker of VISION_MODEL_MARKERS) {
    if (id.includes(marker)) return true;
  }

  return false;
}
