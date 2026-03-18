import { expect, test } from "bun:test";
import * as schema from "db";

test("server imports schema from db package", () => {
  expect(schema.users).toBeTruthy();
  expect(schema.conversations).toBeTruthy();
});
