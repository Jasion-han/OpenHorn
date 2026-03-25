export type TextStreamSmoother = {
  push: (chunk: string) => void;
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

export function createTextStreamSmoother(opts: {
  emit: (text: string) => void;
  now?: () => number;
  config?: Partial<TextStreamSmootherConfig>;
}): TextStreamSmoother {
  const emit = opts.emit;
  const now = opts.now || defaultNow;
  const config: TextStreamSmootherConfig = { ...DEFAULT_CONFIG, ...(opts.config || {}) };

  let mode: "passthrough" | "smooth" = "smooth";
  let buffer = "";
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

  type Segment = { index: number; segment: string };
  type SegmenterLike = { segment: (input: string) => Iterable<Segment> };
  type SegmenterCtorLike = new (
    locales?: string | string[],
    options?: { granularity?: string },
  ) => SegmenterLike;

  const intl = (globalThis as { Intl?: unknown }).Intl;
  const SegmenterCtor = (() => {
    if (!intl || typeof intl !== "object") return undefined;
    const maybe = (intl as { Segmenter?: unknown }).Segmenter;
    return typeof maybe === "function" ? (maybe as unknown as SegmenterCtorLike) : undefined;
  })();

  const segmenter: SegmenterLike | null = SegmenterCtor
    ? new SegmenterCtor(undefined, { granularity: "grapheme" })
    : null;

  const takeGraphemes = (text: string, count: number) => {
    if (count <= 0 || text.length === 0) return { head: "", rest: text };
    if (!segmenter) {
      const chars = Array.from(text);
      return {
        head: chars.slice(0, count).join(""),
        rest: chars.slice(count).join(""),
      };
    }

    let currentCount = 0;
    let endIndex = 0;
    for (const segment of segmenter.segment(text)) {
      endIndex = segment.index + segment.segment.length;
      currentCount += 1;
      if (currentCount >= count) break;
    }

    return { head: text.slice(0, endIndex), rest: text.slice(endIndex) };
  };

  const isAsciiWordChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);
  const isPunctuation = (ch: string) => /[，。！？、；：,.!?:;…]/.test(ch);
  const isOpeningPunct = (ch: string) => /[（([【“‘]/.test(ch);

  const takeNextSlice = (text: string, maxChars: number) => {
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
  };

  const pump = () => {
    cancelFrame = null;
    if (buffer.length === 0) {
      if (finishing && resolveFinish) {
        const done = resolveFinish;
        resolveFinish = null;
        finishing = false;
        finishPromise = null;
        done();
      }
      return;
    }

    const fast =
      buffer.length >= config.fastBacklogChars || emittedChars >= config.fastAfterEmittedChars;
    const maxChars = finishing
      ? config.maxCharsPerTickFinish
      : fast
        ? config.maxCharsPerTickFast
        : config.maxCharsPerTick;
    const { out, rest } = takeNextSlice(buffer, maxChars);
    buffer = rest;

    if (out) {
      emittedChars += out.length;
      emit(out);
    }

    const delay = finishing
      ? config.tickIntervalFinishMs
      : fast
        ? config.tickIntervalFastMs
        : config.tickIntervalMs;
    cancelFrame = nextTick(pump, delay);
  };

  const startPump = () => {
    if (cancelFrame || buffer.length === 0) return;
    cancelFrame = nextTick(pump, 0);
  };

  const flushNow = () => {
    stopPump();
    if (!buffer) return;
    const next = buffer;
    buffer = "";
    emittedChars += next.length;
    emit(next);
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
      stopPump();
      emit(chunk);
      emittedChars += chunk.length;
      return;
    }

    if (emittedChars === 0 && buffer.length === 0) {
      const firstBurst = takeGraphemes(chunk, config.firstBurstChars);
      if (firstBurst.head) {
        emit(firstBurst.head);
        emittedChars += firstBurst.head.length;
      }
      buffer += firstBurst.rest;
      startPump();
      return;
    }

    buffer += chunk;
    startPump();
  };

  const finish = async () => {
    if (mode === "passthrough") return;
    if (finishPromise) return finishPromise;

    finishing = true;
    if (buffer.length === 0) return;

    finishPromise = new Promise<void>((resolve) => {
      resolveFinish = resolve;
      startPump();
    });

    return finishPromise;
  };

  const cancel = (opts?: { flush?: boolean }) => {
    if (opts?.flush) {
      flushNow();
    } else {
      buffer = "";
    }
    stopPump();
    finishing = false;
    finishPromise = null;
    resolveFinish = null;
  };

  return { push, flushNow, finish, cancel };
}
