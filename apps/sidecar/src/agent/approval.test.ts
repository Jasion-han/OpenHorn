import { expect, test } from "bun:test";
import { waitForApproval } from "./approval";

test("host approval cancellation removes its resolver and ignores a late response", async () => {
  const pending = new Map<string, (allow: boolean) => void>();
  const controller = new AbortController();
  let published = 0;
  const result = waitForApproval(pending, "fixture", controller.signal, () => {
    published++;
  });
  const lateReply = pending.get("fixture");
  controller.abort();
  lateReply?.(true);
  expect(await result).toBe(false);
  expect(pending.size).toBe(0);
  expect(published).toBe(1);
});

test("pre-cancelled host approval never publishes and a rejection removes ownership", async () => {
  const pending = new Map<string, (allow: boolean) => void>();
  const controller = new AbortController();
  controller.abort();
  expect(
    await waitForApproval(pending, "cancelled", controller.signal, () => {
      throw new Error("must not publish");
    }),
  ).toBe(false);
  const live = new AbortController();
  const result = waitForApproval(pending, "live", live.signal, () => {});
  pending.get("live")?.(false);
  expect(await result).toBe(false);
  expect(pending.size).toBe(0);
});
