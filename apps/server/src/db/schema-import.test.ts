import { expect, test } from "bun:test";
import * as schema from "db";

test("server imports schema from db package", () => {
  expect(schema.users).toBeTruthy();
  expect(schema.conversations).toBeTruthy();
  expect(schema.agentTasks).toBeTruthy();
  expect(schema.agentRuns).toBeTruthy();
  expect(schema.agentPlanSteps).toBeTruthy();
  expect(schema.agentTaskEvents).toBeTruthy();
  expect(schema.agentApprovalRequests).toBeTruthy();
  expect(schema.agentArtifacts).toBeTruthy();
});
