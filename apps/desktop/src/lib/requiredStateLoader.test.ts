import { expect, test } from "bun:test";
import { createRequiredStateLoader } from "./requiredStateLoader";

test("required data failure retries only its failed group and a later clean reload refreshes all groups", async () => {
  let fail = true,
    identityReads = 0,
    channels = 0,
    conversations = 0;
  const load = createRequiredStateLoader({
    identity: async () => {
      identityReads++;
      return "one";
    },
    owner: () => "one",
    groups: [
      {
        key: "channels",
        load: async () => {
          channels++;
          if (fail) throw new Error("Synthetic 500");
        },
      },
      {
        key: "conversations",
        load: async () => {
          conversations++;
        },
      },
    ],
  });
  let rejected = false;
  await load().catch(() => {
    rejected = true;
  });
  expect(rejected).toBe(true);
  fail = false;
  await load();
  expect(channels).toBe(2);
  expect(conversations).toBe(1);
  expect(identityReads).toBe(2);
  await load();
  expect(channels).toBe(3);
  expect(conversations).toBe(2);
});

test("partial load results cannot be reused across identities", async () => {
  let owner = "one",
    fail = true,
    reads = 0;
  const load = createRequiredStateLoader({
    identity: async () => owner,
    owner: () => owner,
    groups: [
      {
        key: "ok",
        load: async () => {
          reads++;
        },
      },
      {
        key: "fail",
        load: async () => {
          if (fail) throw new Error("failure");
        },
      },
    ],
  });
  await load().catch(() => {});
  owner = "two";
  fail = false;
  await load();
  expect(reads).toBe(2);
});
