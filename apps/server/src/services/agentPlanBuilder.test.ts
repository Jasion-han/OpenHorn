import { expect, test } from "bun:test";
import { buildAgentPlan } from "./agentPlanBuilder";

test("buildAgentPlan creates a compact plan for a quick summary task", () => {
  const plan = buildAgentPlan({
    goal: "Summarize the most important points from this conversation.",
    complexity: "light",
  });

  expect(plan).toHaveLength(3);
  expect(plan[0]?.status).toBe("ready");
  expect(plan.some((step) => step.title.includes("Collect current external information"))).toBe(false);
  expect(plan.some((step) => step.title.includes("Inspect the workspace"))).toBe(false);
});

test("buildAgentPlan adds current-information and verification steps for research tasks", () => {
  const plan = buildAgentPlan({
    goal: "Research the latest OpenAI Responses API changes and cite the key sources.",
    complexity: "standard",
  });

  expect(plan.length).toBeGreaterThanOrEqual(4);
  expect(plan.length).toBeLessThanOrEqual(6);
  expect(plan[0]?.status).toBe("ready");
  expect(plan.some((step) => step.title === "Collect current external information")).toBe(true);
  expect(plan.some((step) => step.title === "Verify evidence and resolve gaps")).toBe(true);
});

test("buildAgentPlan does not treat current workspace phrasing as external-latest research", () => {
  const plan = buildAgentPlan({
    goal: "Read README.md and package.json, then summarize the current project stack in 3 concise bullets.",
    complexity: "light",
  });

  expect(plan.some((step) => step.title === "Collect current external information")).toBe(false);
  expect(plan.some((step) => step.title === "Gather supporting information and evidence")).toBe(false);
  expect(plan.some((step) => step.title === "Inspect the workspace and affected code paths")).toBe(true);
});

test("buildAgentPlan adds attachment context for file-backed tasks", () => {
  const plan = buildAgentPlan({
    goal: "Review the attached PDF and extract the main risks.",
    complexity: "standard",
    attachments: [{ id: "att-1", fileName: "report.pdf", fileType: "application/pdf" }],
  });

  expect(plan.length).toBeGreaterThanOrEqual(4);
  expect(plan.some((step) => step.title === "Read attachments and extract relevant context")).toBe(true);
  expect(plan.some((step) => /Verify outcome|Review quality/.test(step.title))).toBe(true);
});

test("buildAgentPlan adds workspace inspection and validation for code tasks", () => {
  const plan = buildAgentPlan({
    goal: "Inspect the workspace and fix the failing desktop tests.",
    complexity: "deep",
  });

  expect(plan.length).toBeGreaterThanOrEqual(4);
  expect(plan.length).toBeLessThanOrEqual(6);
  expect(plan.some((step) => step.title === "Inspect the workspace and affected code paths")).toBe(true);
  expect(plan.some((step) => step.title === "Validate changes and check risks")).toBe(true);
  expect(plan.at(-1)?.title).toBe("Package the final change summary");
});
