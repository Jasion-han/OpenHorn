import { expect, test } from "bun:test";
import { prioritizeEnabledSkills } from "./sidecarRunSupport";

const skills = [
  { name: "first", description: "d", path: "/fixture/first" },
  { name: "recommended", description: "d", path: "/fixture/recommended" },
  { name: "required", description: "d", path: "/fixture/required" },
];
test("skill recommendations retain the full eligible roster and keep required skills first", () => {
  const result = prioritizeEnabledSkills(skills, ["RECOMMENDED", "not-enabled"], ["required"]);
  expect(result.map((skill) => skill.name)).toEqual(["required", "recommended", "first"]);
  expect(result.length).toBe(skills.length);
  expect(skills[0].name).toBe("first");
  expect(prioritizeEnabledSkills(skills)).toEqual(skills);
});
