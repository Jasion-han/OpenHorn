export type TextStreamSmoother = {
  push: (chunk: string) => void;
  replace: (text: string) => void;
  flushNow: () => void;
  finish: () => Promise<void>;
  cancel: (opts?: { flush?: boolean }) => void;
};

export type TextStreamSmootherConfig = {
  firstBurstChars: number;
  minCharsPerTick: number;
  maxCharsPerTick: number;
  maxAsciiWordCharsPerTick: number;
  maxCharsPerTickFast: number;
  maxCharsPerTickFinish: number;
  fastBacklogChars: number;
  fastAfterEmittedChars: number;
  tickIntervalMs: number;
  tickIntervalFastMs: number;
  tickIntervalFinishMs: number;
  streamyChunkMax: number;
  streamyInterarrivalMaxMs: number;
  streamyChunksToPassthrough: number;
  instantTextMaxChars: number;
};

const DEFAULT_CONFIG: TextStreamSmootherConfig = {
  firstBurstChars: 3,
  minCharsPerTick: 2,
  maxCharsPerTick: 3,
  maxAsciiWordCharsPerTick: 6,
  maxCharsPerTickFast: 3,
  maxCharsPerTickFinish: 3,
  fastBacklogChars: 900,
  fastAfterEmittedChars: 240,
  tickIntervalMs: 14,
  tickIntervalFastMs: 10,
  tickIntervalFinishMs: 8,
  streamyChunkMax: 12,
  streamyInterarrivalMaxMs: 90,
  streamyChunksToPassthrough: 5,
  instantTextMaxChars: 10,
};

function defaultNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function nextTick(cb: () => void, delayMs: number) {
  const id = setTimeout(cb, Math.max(0, delayMs));
  return () => clearTimeout(id);
}

type Segment = { index: number; segment: string };
type SegmenterLike = { segment: (input: string) => Iterable<Segment> };
type SegmenterCtorLike = new (
  locales?: string | string[],
  options?: { granularity?: string },
) => SegmenterLike;

function createSegmenter() {
  const intl = (globalThis as { Intl?: unknown }).Intl;
  if (!intl || typeof intl !== "object") return null;
  const maybe = (intl as { Segmenter?: unknown }).Segmenter;
  if (typeof maybe !== "function") return null;
  const SegmenterCtor = maybe as unknown as SegmenterCtorLike;
  return new SegmenterCtor(undefined, { granularity: "grapheme" });
}

const SEGMENTER = createSegmenter();

function takeGraphemes(text: string, count: number) {
  if (count <= 0 || text.length === 0) return { head: "", rest: text };
  if (!SEGMENTER) {
    const chars = Array.from(text);
    return {
      head: chars.slice(0, count).join(""),
      rest: chars.slice(count).join(""),
    };
  }

  let currentCount = 0;
  let endIndex = 0;
  for (const segment of SEGMENTER.segment(text)) {
    endIndex = segment.index + segment.segment.length;
    currentCount += 1;
    if (currentCount >= count) break;
  }

  return { head: text.slice(0, endIndex), rest: text.slice(endIndex) };
}

function longestCommonPrefix(a: string, b: string) {
  const aChars = Array.from(a);
  const bChars = Array.from(b);
  const length = Math.min(aChars.length, bChars.length);
  let index = 0;
  while (index < length && aChars[index] === bChars[index]) index += 1;
  return aChars.slice(0, index).join("");
}

const isAsciiWordChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);
const isPunctuation = (ch: string) => /[，。！？、；：,.!?:;…]/.test(ch);
const isOpeningPunct = (ch: string) => /[（([【“‘]/.test(ch);

function takeNextSlice(text: string, maxChars: number, config: TextStreamSmootherConfig) {
  if (!text) return { out: "", rest: "" };

  const first = text[0] || "";
  if (first && isAsciiWordChar(first)) {
    let index = 0;
    while (index < text.length && isAsciiWordChar(text[index] || "")) index += 1;
    const cappedLength = Math.max(maxChars, config.maxAsciiWordCharsPerTick);
    let out = text.slice(0, Math.min(index, cappedLength));
    let rest = text.slice(out.length);
    if (rest) {
      const next = takeGraphemes(rest, 1).head;
      if (next && isPunctuation(next)) {
        out += next;
        rest = rest.slice(next.length);
      }
    }
    return { out, rest };
  }

  const targetChars = Math.max(config.minCharsPerTick, maxChars);
  if (targetChars === 3) {
    const two = takeGraphemes(text, 2);
    const next = two.rest ? takeGraphemes(two.rest, 1).head : "";
    if (next && isPunctuation(next)) {
      return { out: two.head + next, rest: two.rest.slice(next.length) };
    }
  }

  let { head, rest } = takeGraphemes(text, targetChars);

  if (rest) {
    const nextChar = takeGraphemes(rest, 1).head;
    if (nextChar && isPunctuation(nextChar)) {
      head += nextChar;
      rest = rest.slice(nextChar.length);
    }
  }

  if (head) {
    const lastChar = Array.from(head).slice(-1)[0] || "";
    if (lastChar && isOpeningPunct(lastChar) && rest) {
      const one = takeGraphemes(rest, 1).head;
      if (one) {
        head += one;
        rest = rest.slice(one.length);
      }
    }
  }

  if (head && Array.from(head).length < config.minCharsPerTick && rest) {
    const need = config.minCharsPerTick - Array.from(head).length;
    const more = takeGraphemes(rest, need);
    head += more.head;
    rest = more.rest;
  }

  return { out: head, rest };
}

export function createTextStreamSmoother(opts: {
  emit: (text: string) => void;
  now?: () => number;
  config?: Partial<TextStreamSmootherConfig>;
}): TextStreamSmoother {
  const emit = opts.emit;
  const now = opts.now || defaultNow;
  const config: TextStreamSmootherConfig = { ...DEFAULT_CONFIG, ...(opts.config || {}) };

  let mode: "passthrough" | "smooth" = "smooth";
  let targetText = "";
  let renderedText = "";
  let emittedChars = 0;
  let firstPushAt: number | null = null;
  let lastPushAt: number | null = null;
  let streamyScore = 0;
  let cancelFrame: null | (() => void) = null;
  let finishing = false;
  let finishPromise: Promise<void> | null = null;
  let resolveFinish: (() => void) | null = null;

  const stopPump = () => {
    if (cancelFrame) cancelFrame();
    cancelFrame = null;
  };

  const resolveIfDone = () => {
    if (renderedText !== targetText || !resolveFinish) return;
    const done = resolveFinish;
    resolveFinish = null;
    finishing = false;
    finishPromise = null;
    done();
  };

  const emitRendered = () => {
    emittedChars = renderedText.length;
    emit(renderedText);
    resolveIfDone();
  };

  const remainingText = () =>
    targetText.startsWith(renderedText) ? targetText.slice(renderedText.length) : "";

  const pump = () => {
    cancelFrame = null;
    const remaining = remainingText();
    if (!remaining) {
      resolveIfDone();
      return;
    }

    const fast =
      remaining.length >= config.fastBacklogChars || emittedChars >= config.fastAfterEmittedChars;
    const maxChars = finishing
      ? config.maxCharsPerTickFinish
      : fast
        ? config.maxCharsPerTickFast
        : config.maxCharsPerTick;
    const { out } = takeNextSlice(remaining, maxChars, config);
    if (out) {
      renderedText += out;
      emitRendered();
    }

    const delay = finishing
      ? config.tickIntervalFinishMs
      : fast
        ? config.tickIntervalFastMs
        : config.tickIntervalMs;
    cancelFrame = nextTick(pump, delay);
  };

  const startPump = () => {
    if (cancelFrame || renderedText === targetText) {
      resolveIfDone();
      return;
    }
    cancelFrame = nextTick(pump, 0);
  };

  const flushNow = () => {
    stopPump();
    if (renderedText === targetText) {
      resolveIfDone();
      return;
    }
    renderedText = targetText;
    emitRendered();
  };

  const replace = (text: string) => {
    const nextText = text || "";
    if (nextText === targetText) return;

    targetText = nextText;

    if (!targetText) {
      stopPump();
      renderedText = "";
      emitRendered();
      return;
    }

    if (mode === "passthrough") {
      stopPump();
      renderedText = targetText;
      emitRendered();
      return;
    }

    if (targetText.length <= config.instantTextMaxChars) {
      stopPump();
      renderedText = targetText;
      emitRendered();
      return;
    }

    if (!targetText.startsWith(renderedText)) {
      const prefix = longestCommonPrefix(renderedText, targetText);
      if (prefix !== renderedText) {
        renderedText = prefix;
        emitRendered();
      }
    }

    if (!renderedText) {
      const firstBurst = takeGraphemes(targetText, config.firstBurstChars);
      if (firstBurst.head) {
        renderedText = firstBurst.head;
        emitRendered();
      }
    }

    startPump();
  };

  const push = (chunk: string) => {
    if (!chunk) return;

    const ts = now();
    if (firstPushAt == null) firstPushAt = ts;
    if (
      lastPushAt != null &&
      chunk.length <= config.streamyChunkMax &&
      ts - lastPushAt <= config.streamyInterarrivalMaxMs
    ) {
      streamyScore += 1;
      if (streamyScore >= config.streamyChunksToPassthrough) {
        mode = "passthrough";
      }
    }
    lastPushAt = ts;

    if (mode === "passthrough") {
      targetText += chunk;
      renderedText = targetText;
      stopPump();
      emitRendered();
      return;
    }

    replace(targetText + chunk);
  };

  const finish = async () => {
    if (mode === "passthrough") return;
    if (finishPromise) return finishPromise;
    if (renderedText === targetText) return;

    finishing = true;
    finishPromise = new Promise<void>((resolve) => {
      resolveFinish = resolve;
      startPump();
    });

    return finishPromise;
  };

  const cancel = (opts?: { flush?: boolean }) => {
    if (opts?.flush) {
      flushNow();
    }
    stopPump();
    if (!opts?.flush) {
      targetText = renderedText;
    }
    finishing = false;
    finishPromise = null;
    resolveFinish = null;
  };

  return { push, replace, flushNow, finish, cancel };
}
