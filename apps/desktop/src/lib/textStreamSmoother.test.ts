import { describe, expect, test } from "bun:test";
import { createTextStreamSmoother } from "./textStreamSmoother";

describe("createTextStreamSmoother", () => {
  test("releases snapshot text in ordered chunks and flushes to the full target", async () => {
    const emissions: string[] = [];
    const smoother = createTextStreamSmoother({
      emit: (text) => {
        emissions.push(text);
      },
      config: {
        firstBurstChars: 1,
        minCharsPerTick: 1,
        maxCharsPerTick: 1,
        maxCharsPerTickFast: 1,
        maxCharsPerTickFinish: 10,
        tickIntervalMs: 0,
        tickIntervalFastMs: 0,
        tickIntervalFinishMs: 0,
        instantTextMaxChars: 0,
      },
    });

    smoother.replace("你好世界");

    expect(emissions[0]).toBe("你");

    await smoother.finish();

    expect(emissions[emissions.length - 1]).toBe("你好世界");
    expect(emissions.every((text, index) => index === 0 || text.startsWith(emissions[index - 1] || ""))).toBe(
      true,
    );
  });

  test("bypasses pacing for short text", () => {
    const emissions: string[] = [];
    const smoother = createTextStreamSmoother({
      emit: (text) => {
        emissions.push(text);
      },
    });

    smoother.replace("简短结果");

    expect(emissions).toEqual(["简短结果"]);
  });

  test("replaces the active target with a newer snapshot without duplicating prefixes", async () => {
    const emissions: string[] = [];
    const smoother = createTextStreamSmoother({
      emit: (text) => {
        emissions.push(text);
      },
      config: {
        firstBurstChars: 2,
        minCharsPerTick: 1,
        maxCharsPerTick: 1,
        maxCharsPerTickFast: 1,
        maxCharsPerTickFinish: 10,
        tickIntervalMs: 0,
        tickIntervalFastMs: 0,
        tickIntervalFinishMs: 0,
        instantTextMaxChars: 0,
      },
    });

    smoother.replace("读取REA");
    expect(emissions[0]).toBe("读取");

    smoother.replace("读取README.md");
    await smoother.finish();

    expect(emissions[emissions.length - 1]).toBe("读取README.md");
    expect(emissions.includes("读取REA读取README.md")).toBe(false);
  });

  test("flushNow emits the full target immediately", () => {
    const emissions: string[] = [];
    const smoother = createTextStreamSmoother({
      emit: (text) => {
        emissions.push(text);
      },
      config: {
        firstBurstChars: 1,
        minCharsPerTick: 1,
        maxCharsPerTick: 1,
        maxCharsPerTickFast: 1,
        maxCharsPerTickFinish: 1,
        tickIntervalMs: 100,
        tickIntervalFastMs: 100,
        tickIntervalFinishMs: 100,
        instantTextMaxChars: 0,
      },
    });

    smoother.replace("需要立即完成");
    expect(emissions[0]).toBe("需");

    smoother.flushNow();

    expect(emissions[emissions.length - 1]).toBe("需要立即完成");
  });
});
