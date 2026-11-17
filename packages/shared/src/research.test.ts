import { expect, test } from "bun:test";
import {
  isResearchProtocol,
  researchQuestion,
  withoutResearchCommand,
  withResearchCommand,
} from "./research";

test("research command preserves the user's actual question and cannot match a mid-sentence instruction", () => {
  expect(researchQuestion(" /research Compare sources\nwith dates ")).toBe(
    "Compare sources\nwith dates",
  );
  expect(researchQuestion("Discuss /research topic")).toBe(null);
  expect(researchQuestion("/researcher topic")).toBe(null);
  expect(withResearchCommand("hello")).toBe("/research hello");
  expect(withResearchCommand("/research hello")).toBe("/research hello");
  expect(withoutResearchCommand("/research hello")).toBe("hello");
  expect(isResearchProtocol("acp")).toBe(false);
  expect(isResearchProtocol("anthropic")).toBe(true);
});
