import { expect, test } from "bun:test";
import { sanitizeChildEnv } from "./child-env";

test("Jev service credentials never reach spawned tools or agent children", () => {
  const input = {
    PATH: "/synthetic/bin",
    TYPESAFE_API_KEY: "synthetic-typesafe-only",
    OPENROUTER_API_KEY: "synthetic-openrouter-only",
    OPENHORN_JEV_API_KEY: "synthetic-service-only",
  };
  const output = sanitizeChildEnv(input);
  expect(output.PATH).toBe(input.PATH);
  expect(output.TYPESAFE_API_KEY).toBe(undefined);
  expect(output.OPENROUTER_API_KEY).toBe(undefined);
  expect(output.OPENHORN_JEV_API_KEY).toBe(undefined);
  expect(input.TYPESAFE_API_KEY).toBe("synthetic-typesafe-only");
});
