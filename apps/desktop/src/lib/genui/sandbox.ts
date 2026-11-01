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
export const MAX_LINK_LENGTH = 2048;

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

// Only trusted code is present during the initial document load. The parent
// supplies the fragment afterwards, so a model script cannot cancel that load
// with a redirect and masquerade as the initial document. Scripts parsed by a
// template are inert; recreating them in order preserves classic CDN/inline
// dependencies without replacing the document (and its CSP).
const FRAME_RUNTIME = `<script>(function(){
var T=${JSON.stringify(MESSAGE_TYPE)},last=0,started=false,moduleSequence=0;
function post(m){m.type=T;parent.postMessage(m,"*")}
function measure(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);if(Math.abs(h-last)>1){last=h;post({action:"height",height:h})}}
window.openhorn={
sendPrompt:function(o){post({action:"sendPrompt",text:String(o&&o.text!=null?o.text:o)})},
openLink:function(o){post({action:"openLink",url:String(o&&o.url!=null?o.url:o)})}
};
function executeScript(original,script,type){return new Promise(function(resolve){
var completion,settled=false;
function done(){
if(settled)return;settled=true;
if(completion)window.removeEventListener(completion,done);
window.removeEventListener("error",done);window.removeEventListener("unhandledrejection",done);
script.removeEventListener("load",done);script.removeEventListener("error",done);resolve();
}
script.addEventListener("load",done,{once:true});script.addEventListener("error",done,{once:true});
if(type==="module"&&!script.hasAttribute("src")){
// Inline modules have no load event. This local completion event only orders
// the fragment's scripts; it carries no authority outside this document. Import
// failures use the script's error event, evaluation failures a window error or
// rejected top-level await. None may strand the rest of the fragment forever.
completion="openhorn-fragment-module-"+(++moduleSequence);
window.addEventListener(completion,done,{once:true});window.addEventListener("error",done,{once:true});
window.addEventListener("unhandledrejection",done,{once:true});
script.textContent+="\\n;window.dispatchEvent(new Event("+JSON.stringify(completion)+"));";
}
original.replaceWith(script);
})}
async function render(html){
var template=document.createElement("template");template.innerHTML=html;
var scripts=Array.from(template.content.querySelectorAll("script"));
var asynchronous=[];
document.body.appendChild(template.content);
for(var original of scripts){
if(!original.isConnected)continue;
var script=document.createElement("script");
for(var attribute of original.attributes)script.setAttribute(attribute.name,attribute.value);
script.textContent=original.textContent;
var type=(script.getAttribute("type")||"").split(";")[0].trim().toLowerCase();
var executable=["","module","text/javascript","application/javascript","text/ecmascript","application/ecmascript"].includes(type);
// Modern engines ignore classic nomodule fallbacks without load/error events.
// Preserve that behavior without awaiting an event which will never arrive.
if(type!=="module"&&script.noModule&&("noModule" in script)){original.replaceWith(script);continue}
if(executable&&(script.hasAttribute("src")||type==="module")){
var isAsync=script.hasAttribute("async");if(!isAsync)script.async=false;
var ready=executeScript(original,script,type);
if(isAsync)asynchronous.push(ready);else await ready;
}else{original.replaceWith(script)}
}
document.dispatchEvent(new Event("DOMContentLoaded",{bubbles:true}));
await Promise.all(asynchronous);
window.dispatchEvent(new Event("load"));
measure();
}
addEventListener("message",function(e){
if(e.source!==parent||!e.data||e.data.type!==T)return;
if(e.data.action==="measure"){last=0;measure()}
if(e.data.action==="render"&&!started&&typeof e.data.html==="string"){started=true;render(e.data.html)}
});
// A destination can stream forever without firing load. This report only
// revokes the frame; it never authorizes an action from its replacement.
addEventListener("pagehide",function(){post({action:"navigated"})},true);
new ResizeObserver(measure).observe(document.documentElement);
})()</script>`;

function head(csp: string, theme: ThemeSnapshot): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${themeCss(theme)}</style>`;
}

export function buildSandboxDocument(theme: ThemeSnapshot): string {
  return `${head(SANDBOX_CSP, theme)}${FRAME_RUNTIME}<body></body>`;
}

export function buildPreviewDocument(styles: string, markup: string, theme: ThemeSnapshot): string {
  return `${head(PREVIEW_CSP, theme)}${styles}${markup}`;
}

export type BridgeMessage =
  | { action: "height"; height: number }
  | { action: "navigated" }
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
    case "navigated":
      return { action: "navigated" };
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

/** An absolute http(s) URL, or null for anything else (javascript:, data:, relative). */
export function safeWebUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length > MAX_LINK_LENGTH) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
