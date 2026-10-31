/**
 * The document a ```html-ui block runs in, and the checks on what it may send
 * back. The frame is `sandbox="allow-scripts"` without allow-same-origin, so it
 * has an opaque origin: no access to the app's DOM, storage, cookies or Tauri
 * IPC. The CSP below comes first in the document, so it covers all of the
 * model's markup: inline code and a few script CDNs only, no other network.
 */

const SCRIPT_CDNS =
  "https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh";

export const SANDBOX_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${SCRIPT_CDNS}`,
  `style-src 'unsafe-inline' ${SCRIPT_CDNS} https://fonts.googleapis.com`,
  "font-src https://fonts.gstatic.com data:",
  "img-src data: blob: https:",
  "media-src data: blob:",
  `connect-src ${SCRIPT_CDNS}`,
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** The static preview shown while a block streams runs no script at all. */
export const PREVIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: blob: https:",
  "font-src data:",
].join("; ");

export const MESSAGE_TYPE = "openhorn-genui";
export const MIN_FRAME_HEIGHT = 80;
export const MAX_FRAME_HEIGHT = 2400;
export const MAX_PROMPT_LENGTH = 2000;

/** Theme variables copied into the frame so model-written HTML can match the app. */
export const THEME_VARIABLES = [
  "--background",
  "--foreground",
  "--muted",
  "--muted-foreground",
  "--border",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--card",
] as const;

export type ThemeSnapshot = {
  dark: boolean;
  variables: Partial<Record<(typeof THEME_VARIABLES)[number], string>>;
};

export function readThemeSnapshot(): ThemeSnapshot {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const variables: ThemeSnapshot["variables"] = {};
  for (const name of THEME_VARIABLES) {
    const value = computed.getPropertyValue(name).trim();
    // Only HSL triplets ("0 0% 100%") are copied, so nothing else can be
    // smuggled into the frame's stylesheet.
    if (/^[\d.\s%]+$/.test(value)) variables[name] = value;
  }
  return { dark: root.classList.contains("dark"), variables };
}

function themeCss(theme: ThemeSnapshot): string {
  const vars = Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `:root{color-scheme:${theme.dark ? "dark" : "light"};${vars}}html,body{margin:0;background:transparent}body{color:hsl(var(--foreground));font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB",sans-serif}`;
}

// Runs before the model's markup: reports the content height, and exposes the
// two bridge calls. The parent can ask for a fresh height ("measure") because a
// frame may report before the app is listening.
const FRAME_RUNTIME = `<script>(function(){var T=${JSON.stringify(MESSAGE_TYPE)},last=0;function post(m){m.type=T;parent.postMessage(m,"*")}function send(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);if(Math.abs(h-last)>1){last=h;post({action:"height",height:h})}}addEventListener("message",function(e){if(e.source===parent&&e.data&&e.data.type===T&&e.data.action==="measure"){last=0;send()}});addEventListener("load",send);new ResizeObserver(send).observe(document.documentElement);window.openhorn={sendPrompt:function(o){post({action:"sendPrompt",text:String(o&&o.text!=null?o.text:o)})},openLink:function(o){post({action:"openLink",url:String(o&&o.url!=null?o.url:o)})}};send()})()</script>`;

function head(csp: string, theme: ThemeSnapshot): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${themeCss(theme)}</style>`;
}

export function buildSandboxDocument(html: string, theme: ThemeSnapshot): string {
  return `${head(SANDBOX_CSP, theme)}${FRAME_RUNTIME}${html}`;
}

export function buildPreviewDocument(styles: string, markup: string, theme: ThemeSnapshot): string {
  return `${head(PREVIEW_CSP, theme)}${styles}${markup}`;
}

export type BridgeMessage =
  | { action: "height"; height: number }
  | { action: "sendPrompt"; text: string }
  | { action: "openLink"; url: string };

/**
 * Validates a message from the frame. Anything that is not exactly one of the
 * known shapes is dropped; the caller must also check `event.source`.
 */
export function parseBridgeMessage(data: unknown): BridgeMessage | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.type !== MESSAGE_TYPE) return null;
  switch (message.action) {
    case "height": {
      const height = message.height;
      if (typeof height !== "number" || !Number.isFinite(height)) return null;
      return {
        action: "height",
        height: Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.ceil(height))),
      };
    }
    case "sendPrompt": {
      const text = typeof message.text === "string" ? message.text.trim() : "";
      if (!text) return null;
      return { action: "sendPrompt", text: text.slice(0, MAX_PROMPT_LENGTH) };
    }
    case "openLink": {
      const url = safeWebUrl(message.url);
      return url ? { action: "openLink", url } : null;
    }
    default:
      return null;
  }
}

/**
 * Whether a validated message may act now. `sendPrompt` and `openLink` need
 * the user to be interacting with that frame (it is the parent's
 * activeElement, which a cross-origin frame cannot arrange without a user
 * gesture); otherwise a script could fill the composer or open links on load.
 * `height` is always accepted.
 */
export function acceptsUserAction(message: BridgeMessage, frameFocused: boolean): boolean {
  return message.action === "height" || frameFocused;
}

/** An absolute http(s) URL, or null for anything else (javascript:, data:, relative). */
export function safeWebUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
