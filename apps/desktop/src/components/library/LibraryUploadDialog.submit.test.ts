import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

declare const Bun: {
  Transpiler: new (options: { loader: "tsx" }) => { transformSync(source: string): string };
};

// Exercise the actual form handler without a native picker or a network upload.
const source = readFileSync(new URL("./LibraryUploadDialog.tsx", import.meta.url), "utf8");
const handler = source.match(/onSubmit=\{(async \(event\) => \{[\s\S]*?)\n {10}\}\}/)?.[1];
if (!handler) throw new Error("Upload form submit handler not found");

function harness(discard: boolean) {
  let finish!: (accepted: boolean) => void;
  const calls = { uploads: 0, closed: 0, cleared: 0, prevented: 0 };
  const lock = { current: false };
  const busy: boolean[] = [];
  const scope = {
    discard,
    file: new File(["Generated upload regression"], "qa.txt"),
    lock,
    scope: { kind: "personal" },
    setBusy: (value: boolean) => busy.push(value),
    onUpload: async () => {
      calls.uploads++;
      return await new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    },
    useLibraryDraftStore: {
      getState: () => ({ setUpload: () => calls.cleared++ }),
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
