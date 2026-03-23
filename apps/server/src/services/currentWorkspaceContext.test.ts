import { expect, test } from "bun:test";
import { buildCurrentWorkspaceSystemContext } from "./currentWorkspaceContext";

test("buildCurrentWorkspaceSystemContext loads the local README content", () => {
  const context = buildCurrentWorkspaceSystemContext();

  expect(context).toContain("Current workspace question detected.");
  expect(context).toContain("Resolved README path:");
  expect(context).toContain("# OpenHorn");
  expect(context).toContain("OpenHorn is a self-hostable AI workspace");
});
