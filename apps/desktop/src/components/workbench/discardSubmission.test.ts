import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { PrepareLibraryQuestionInput } from "shared/types";

declare const Bun: {
  Transpiler: new (options: { loader: "tsx" }) => { transformSync(source: string): string };
};

// Run the components' real submission functions with local callback recorders.
// These tests never create a conversation, version or model request.
function compile<T>(source: string, bindings: Record<string, unknown>, result: string): T {
  return new Function(
    "bindings",
    new Bun.Transpiler({ loader: "tsx" }).transformSync(`
      const { ${Object.keys(bindings).join(", ")} } = bindings;
      ${source}
      return ${result};
    `),
  )(bindings) as T;
}

const questionSource = readFileSync(
  new URL("../library/LibraryQuestionDialog.tsx", import.meta.url),
  "utf8",
);
const questionHandler = questionSource.match(
  /onSubmit=\{(async \(event\) => \{[\s\S]*?)\n {10}\}\}/,
)?.[1];
if (!questionHandler) throw new Error("Library question submit function not found");

function questionHarness(discard: boolean) {
  const payloads: PrepareLibraryQuestionInput[] = [];
  const writes: unknown[] = [];
  const lock = { current: false };
  const busy: boolean[] = [];
  let closed = 0;
  const handler = compile<(event: { preventDefault(): void }) => Promise<void>>(
    `const submit = ${questionHandler}\n};`,
    {
      discard,
      question: "  Generated question  ",
      validModel: true,
      model: JSON.stringify(["qa-channel", "qa-model"]),
      scope: { kind: "personal" },
      lock,
      retry: { current: null },
      crypto,
      libraryScopeKey: () => "personal",
      useLibraryDraftStore: { getState: () => ({ setQuestion: (v: unknown) => writes.push(v) }) },
      setBusy: (v: boolean) => busy.push(v),
      onPrepare: async (input: PrepareLibraryQuestionInput) => {
        payloads.push(input);
        return false;
      },
      onClose: () => closed++,
    },
    "submit",
  );
  return {
    submit: () => handler({ preventDefault() {} }),
    payloads,
    writes,
    busy,
    lock,
    get closed() {
      return closed;
    },
  };
}

test("discard confirmation blocks question preparation and leaves its draft untouched", async () => {
  const qa = questionHarness(true);
  await qa.submit();
  expect(qa.payloads).toEqual([]);
  expect(qa.writes).toEqual([]);
  expect(qa.busy).toEqual([]);
  expect(qa.lock.current).toBe(false);
});

test("ordinary question retry retains its request identity and draft", async () => {
  const qa = questionHarness(false);
  await qa.submit();
  await qa.submit();
  expect(qa.payloads).toHaveLength(2);
  expect(qa.payloads[0].question).toBe("Generated question");
  expect(qa.payloads[0].requestId).toBe(qa.payloads[1].requestId);
  expect(qa.writes).toHaveLength(2);
  expect(qa.closed).toBe(0);
  expect(qa.lock.current).toBe(false);
});

const artifactSource = readFileSync(new URL("./ArtifactPanel.tsx", import.meta.url), "utf8");
const start = artifactSource.indexOf("  const saveVersion = ");
const end = artifactSource.indexOf("  const restoreVersion = ", start);
if (start < 0 || end < 0) throw new Error("Artifact save function not found");

function artifactHarness(confirmDiscard: boolean) {
  const requests: unknown[] = [];
  const pending: Promise<void>[] = [];
  const editDraft = { expectedVersion: 1 };
  let cleared = 0;
  let version = 1;
  const save = compile<() => void>(
    artifactSource.slice(start, end),
    {
      confirmDiscard,
      detail: { artifact: { id: "qa-artifact", currentVersion: 1 } },
      draft: "Generated edited content",
      draftFormat: "markdown",
      editDraft,
      useArtifactDraftStore: {
        getState: () => ({
          ownerId: "qa-owner",
          drafts: { "qa-artifact": editDraft },
          discard: () => cleared++,
        }),
      },
      act: (_name: string, work: () => Promise<void>) => pending.push(work()),
      workbenchApi: {
        artifacts: {
          append: async (_id: string, input: unknown) => {
            requests.push(input);
            return { version: { version: 2 } };
          },
        },
      },
      setSelectedVersion: (v: number) => {
        version = v;
      },
      loadList: async () => {},
    },
    "saveVersion",
  );
  return {
    run: async () => {
      save();
      await Promise.all(pending);
      return { requests, cleared, version };
    },
  };
}

test("discard confirmation cannot append an artifact version or clear its draft", async () => {
  expect(await artifactHarness(true).run()).toEqual({ requests: [], cleared: 0, version: 1 });
});

test("ordinary artifact save retains the expected-version contract", async () => {
  expect(await artifactHarness(false).run()).toEqual({
    requests: [{ expectedVersion: 1, content: "Generated edited content", format: "markdown" }],
    cleared: 1,
    version: 2,
  });
});
