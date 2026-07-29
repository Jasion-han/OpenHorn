import { describe, expect, test } from "bun:test";
import type { Conversation } from "../../types/chat";
import { groupByCreatedAt } from "./DesktopLeftSidebar";

const conversation = (id: string, createdAt: Date): Conversation =>
  ({ id, title: id, createdAt, isPinned: false }) as Conversation;

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);

const labelsFor = (items: Conversation[], now: Date) =>
  groupByCreatedAt(items, now).map((group) => group.label);

describe("groupByCreatedAt", () => {
  test("splits on local midnight, not on elapsed hours", () => {
    // The bug this covers: a conversation started at 23:50 must read as
    // "yesterday" ten minutes later, even though barely any time has passed.
    const now = at(2026, 7, 29, 0, 0);
    const justBeforeMidnight = conversation("late", at(2026, 7, 28, 23, 50));
    expect(labelsFor([justBeforeMidnight], now)).toEqual(["sidebar.group.yesterday"]);
  });

  test("the same list regroups once the day turns", () => {
    // Passing `now` in is what makes this possible to assert at all — and what
    // the component now re-supplies on the day boundary rather than at mount.
    const items = [conversation("a", at(2026, 7, 29, 14, 0))];
    expect(labelsFor(items, at(2026, 7, 29, 23, 0))).toEqual(["sidebar.group.today"]);
    expect(labelsFor(items, at(2026, 7, 30, 1, 0))).toEqual(["sidebar.group.yesterday"]);
    expect(labelsFor(items, at(2026, 7, 31, 1, 0))).toEqual(["sidebar.group.earlier"]);
  });

  test("midnight exactly belongs to the new day", () => {
    const now = at(2026, 7, 29, 9, 0);
    const atMidnight = conversation("edge", at(2026, 7, 29, 0, 0));
    expect(labelsFor([atMidnight], now)).toEqual(["sidebar.group.today"]);
  });

  test("empty groups are omitted, and the order is today then yesterday then earlier", () => {
    const now = at(2026, 7, 29, 9, 0);
    const items = [
      conversation("old", at(2026, 1, 1)),
      conversation("today", at(2026, 7, 29, 8, 0)),
    ];
    expect(labelsFor(items, now)).toEqual(["sidebar.group.today", "sidebar.group.earlier"]);
  });

  test("each group is sorted newest first", () => {
    const now = at(2026, 7, 29, 20, 0);
    const items = [
      conversation("morning", at(2026, 7, 29, 8, 0)),
      conversation("evening", at(2026, 7, 29, 19, 0)),
      conversation("noon", at(2026, 7, 29, 12, 0)),
    ];
    const ids = groupByCreatedAt(items, now)[0].items.map((item) => item.id);
    expect(ids).toEqual(["evening", "noon", "morning"]);
  });
});
