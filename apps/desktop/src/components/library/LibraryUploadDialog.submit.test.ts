import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

declare const Bun: {
  Transpiler: new (options: { loader: "tsx" }) => { transformSync(source: string): string };
};

// Exercise the actual form handler without a native picker or a network upload.
const source = readFileSync(new URL("./LibraryUploadDialog.tsx", import.meta.url), "utf8");
const handler = source.match(/onSubmit=\{(async \(event\) => \{[\s\S]*?)\n {10}\}\}/)?.[1];
if (!handler) throw new Error("Upload form submit handler not found");

function harness(discard: boolean, fileNames = ["qa.txt"], destinationAvailable = true) {
  let finish!: (accepted: boolean) => void;
  const calls = { uploads: 0, closed: 0, cleared: 0, prevented: 0 };
  const lock = { current: false };
  const busy: boolean[] = [];
  const acknowledged: string[][] = [];
  const uploaded: string[] = [];
  const failures: string[] = [];
  const stop = { current: false };
  let active = true;
  const scope = {
    discard,
    files: fileNames.map((name) => new File(["Generated upload regression"], name)),
    lock,
    stop,
    active: () => active,
    beginUpload: () => true,
    endUpload: () => {},
    scope: { kind: "personal" },
    destinationId: undefined,
    destinationAvailable,
    setBusy: (value: boolean) => busy.push(value),
    setError: () => {},
    setCompleted: () => {},
    setTotal: () => {},
    setStopping: () => {},
    setFailedFile: (file: File | null) => {
      if (file) failures.push(file.name);
    },
    acknowledge: (_previous: File[], files: File[]) => {
      acknowledged.push(files.map((file) => file.name));
      if (files.length === 0) calls.cleared++;
    },
    onUpload: async (_scope: unknown, file: File) => {
      calls.uploads++;
      uploaded.push(file.name);
      return await new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    },
    onClose: () => calls.closed++,
  };
  const build = new Function(
    "fixture",
    new Bun.Transpiler({ loader: "tsx" }).transformSync(`
      const { ${Object.keys(scope).join(", ")} } = fixture;
      return ${handler}\n};
    `),
  ) as (scope: unknown) => (event: { preventDefault(): void }) => Promise<void>;
  const submit = build(scope);
  return {
    submit: () => submit({ preventDefault: () => calls.prevented++ }),
    finish: (accepted: boolean) => finish(accepted),
    calls,
    busy,
    lock,
    stop,
    acknowledged,
    uploaded,
    failures,
    leave: () => {
      active = false;
    },
  };
}

test("pending discard confirmation blocks form submission without touching the file draft", async () => {
  const qa = harness(true);
  // Do not await an accidental upload: the failing baseline would wait forever.
  void qa.submit();
  expect(qa.calls).toEqual({ uploads: 0, closed: 0, cleared: 0, prevented: 1 });
  expect(qa.busy).toEqual([]);
  expect(qa.lock.current).toBe(false);
});

test("a missing destination blocks submission and keeps the file draft", async () => {
  const qa = harness(false, ["qa.txt"], false);
  void qa.submit();
  expect(qa.calls).toEqual({ uploads: 0, closed: 0, cleared: 0, prevented: 1 });
  expect(qa.busy).toEqual([]);
});

test("ordinary upload is one-shot while pending and keeps its file on rejection", async () => {
  const qa = harness(false);
  const first = qa.submit();
  await qa.submit();
  expect(qa.calls.uploads).toBe(1);
  qa.finish(false);
  await first;
  expect(qa.calls.closed).toBe(0);
  expect(qa.calls.cleared).toBe(0);
  expect(qa.busy).toEqual([true, false]);
  expect(qa.lock.current).toBe(false);
});

test("accepted upload clears only after the real handler receives success", async () => {
  const qa = harness(false);
  const pending = qa.submit();
  expect(qa.calls.cleared).toBe(0);
  qa.finish(true);
  await pending;
  expect(qa.calls.closed).toBe(1);
  expect(qa.calls.cleared).toBe(1);
});

test("the batch removes each accepted file and stops on the first failed file", async () => {
  const qa = harness(false, ["first.txt", "failed.txt", "later.txt"]);
  const pending = qa.submit();
  expect(qa.uploaded).toEqual(["first.txt"]);
  qa.finish(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(qa.uploaded).toEqual(["first.txt", "failed.txt"]);
  qa.finish(false);
  await pending;
  expect(qa.acknowledged).toEqual([["failed.txt", "later.txt"]]);
  expect(qa.failures).toEqual(["failed.txt"]);
  expect(qa.calls.closed).toBe(0);
});

for (const stop of ["pause", "leave"]) {
  test(`the batch acknowledges the active file and stops after ${stop}`, async () => {
    const qa = harness(false, ["first.txt", "later.txt"]);
    const pending = qa.submit();
    if (stop === "pause") qa.stop.current = true;
    else qa.leave();
    qa.finish(true);
    await pending;
    expect(qa.uploaded).toEqual(["first.txt"]);
    expect(qa.acknowledged).toEqual([["later.txt"]]);
    expect(qa.calls.closed).toBe(0);
  });
}
