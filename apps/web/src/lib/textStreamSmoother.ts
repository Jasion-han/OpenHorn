export type TextStreamSmoother = {
  push: (chunk: string) => void;
  flushNow: () => void;
  finish: () => Promise<void>;
  cancel: (opts?: { flush?: boolean }) => void;
};

export type TextStreamSmootherConfig = {
  // How many characters (graphemes) to show immediately when smoothing starts.
  firstBurstChars: number;
  // Streamy feel: emit a very small number of characters per tick.
  minCharsPerTick: number;
  maxCharsPerTick: number;
  // Avoid huge chunks when encountering long ASCII tokens.
  maxAsciiWordCharsPerTick: number;
  // Speed up when backlog is large (keeps overall speed high).
  maxCharsPerTickFast: number;
  // Speed up aggressively when finishing (avoid slow tails).
  maxCharsPerTickFinish: number;
  // Backlog threshold for fast mode (based on buffered UTF-16 length).
  fastBacklogChars: number;
  // After emitting enough text, allow fast mode even without backlog.
  fastAfterEmittedChars: number;
  // Tick cadence in ms. Faster cadence increases perceived streaming without increasing chunk size.
  tickIntervalMs: number;
  tickIntervalFastMs: number;
  tickIntervalFinishMs: number;
  // Heuristic: if we see many tiny, frequent chunks, assume real token streaming and pass through.
  streamyChunkMax: number;
  streamyInterarrivalMaxMs: number;
  streamyChunksToPassthrough: number;
};

const DEFAULT_CONFIG: TextStreamSmootherConfig = {
  firstBurstChars: 3,
  minCharsPerTick: 2,
  maxCharsPerTick: 3,
  maxAsciiWordCharsPerTick: 6,
  // Keep chunks small (2-3 chars). Speed comes from faster cadence, not bigger slices.
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
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
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

  // Default to smooth mode so even single-chunk replies render progressively.
  // If upstream is truly token-streaming (many tiny, frequent chunks), we switch
  // to passthrough to avoid artificially delaying.
  let mode: 'passthrough' | 'smooth' = 'smooth';
  let buffer = '';
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

  // Avoid referencing Intl.Segmenter types directly (tsconfig may not include es2022.intl lib).
  const SegmenterCtor = (globalThis as any)?.Intl?.Segmenter as
    | (new (locales?: string | string[], options?: any) => { segment: (input: string) => Iterable<any> })
    | undefined;
  const segmenter: { segment: (input: string) => Iterable<any> } | null =
    SegmenterCtor ? new SegmenterCtor(undefined, { granularity: 'grapheme' }) : null;

  const takeGraphemes = (text: string, n: number) => {
    if (n <= 0 || text.length === 0) return { head: '', rest: text };
    if (!segmenter) {
      const arr = Array.from(text);
      const head = arr.slice(0, n).join('');
      const rest = arr.slice(n).join('');
      return { head, rest };
    }
    let count = 0;
    let endIndex = 0;
    for (const seg of segmenter.segment(text)) {
      endIndex = seg.index + seg.segment.length;
      count += 1;
      if (count >= n) break;
    }
    return { head: text.slice(0, endIndex), rest: text.slice(endIndex) };
  };

  const isAsciiWordChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);
  const isPunctuation = (ch: string) => /[，。！？、；：,.!?:;…]/.test(ch);
  const isOpeningPunct = (ch: string) => /[（(\[【“‘]/.test(ch);

  const takeNextSlice = (text: string, maxChars: number) => {
    if (!text) return { out: '', rest: '' };

    const first = text[0] || '';

    // Don't split inside ASCII words: emit the whole word.
    if (first && isAsciiWordChar(first)) {
      let i = 0;
      while (i < text.length && isAsciiWordChar(text[i] || '')) i++;
      const cap = Math.max(maxChars, config.maxAsciiWordCharsPerTick);
      const outLen = Math.min(i, cap);
      let out = text.slice(0, outLen);
      let rest = text.slice(outLen);
      // Attach immediate punctuation (e.g. "," "." ":" "，") to avoid awkward trailing punctuation.
      if (rest) {
        const next = takeGraphemes(rest, 1).head;
        if (next && isPunctuation(next)) {
          out += next;
          rest = rest.slice(next.length);
        }
      }
      return { out, rest };
    }

    const max = Math.max(config.minCharsPerTick, maxChars);

    // For the "2-3 chars" mode, prefer "2 + punctuation" (e.g. "你好，") rather than "3 then ，".
    if (max === 3) {
      const two = takeGraphemes(text, 2);
      const next = two.rest ? takeGraphemes(two.rest, 1).head : '';
      if (next && isPunctuation(next)) {
        return { out: two.head + next, rest: two.rest.slice(next.length) };
      }
    }

    let { head, rest } = takeGraphemes(text, max);

    // Attach punctuation to the previous slice when it comes immediately after.
    if (rest) {
      const nextChar = takeGraphemes(rest, 1).head;
      if (nextChar && isPunctuation(nextChar)) {
        head += nextChar;
        rest = rest.slice(nextChar.length);
      }
    }

    // Avoid ending on opening punctuation/quotes like "（" or "“" (looks awkward).
    if (head) {
      const lastChar = Array.from(head).slice(-1)[0] || '';
      if (lastChar && isOpeningPunct(lastChar) && rest) {
        const one = takeGraphemes(rest, 1).head;
        if (one) {
          head += one;
          rest = rest.slice(one.length);
        }
      }
    }

    // Enforce min output when possible.
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
        const r = resolveFinish;
        resolveFinish = null;
        finishing = false;
        finishPromise = null;
        r();
      }
      return;
    }

    const fast =
      buffer.length >= config.fastBacklogChars
      || emittedChars >= config.fastAfterEmittedChars;
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
    if (cancelFrame) return;
    cancelFrame = nextTick(pump, config.tickIntervalMs);
  };

  const maybeSwitchToPassthrough = (chunk: string, ts: number) => {
    if (mode !== 'smooth') return;
    if (lastPushAt == null) return;

    const dt = ts - lastPushAt;
    if (dt <= config.streamyInterarrivalMaxMs && chunk.length <= config.streamyChunkMax) {
      streamyScore += 1;
    } else {
      streamyScore = Math.max(0, streamyScore - 1);
    }
    if (streamyScore >= config.streamyChunksToPassthrough) {
      // Upstream is already nicely streaming; stop smoothing.
      mode = 'passthrough';
      flushNow();
    }
  };

  const flushNow = () => {
    stopPump();
    if (!buffer) return;
    const out = buffer;
    buffer = '';
    emittedChars += out.length;
    emit(out);
  };

  const finish = async () => {
    if (finishPromise) return finishPromise;

    // If passthrough, there's no buffer to drain.
    if (mode !== 'smooth') return;

    finishing = true;
    finishPromise = new Promise<void>((resolve) => {
      resolveFinish = resolve;
    });
    startPump();
    return finishPromise;
  };

  const push = (chunk: string) => {
    if (typeof chunk !== 'string' || chunk.length === 0) return;

    const ts = now();
    if (firstPushAt == null) firstPushAt = ts;

    maybeSwitchToPassthrough(chunk, ts);

    if (mode === 'passthrough') {
      emit(chunk);
      lastPushAt = ts;
      return;
    }

    // smooth
    if (buffer.length === 0 && !finishing) {
      const { head, rest } = takeGraphemes(chunk, config.firstBurstChars);
      if (head) {
        emittedChars += head.length;
        emit(head);
      }
      if (rest) buffer += rest;
    } else {
      buffer += chunk;
    }
    startPump();
    lastPushAt = ts;
  };

  const cancel = (cancelOpts?: { flush?: boolean }) => {
    stopPump();
    if (cancelOpts?.flush) {
      flushNow();
    } else {
      buffer = '';
    }
    finishing = false;
    resolveFinish = null;
    finishPromise = null;
  };

  return { push, flushNow, finish, cancel };
}
