import { expect, test } from "bun:test";
import { missingRecipeCapabilities, renderRecipePrompt, validateRecipeSpec } from "./recipes";

const spec = {
  title: "Synthetic recipe",
  description: "Synthetic",
  promptTemplate: "Inspect {{file}} with threshold {{count}}.",
  parameters: [
    { key: "file", label: "File", type: "text", required: true },
    { key: "count", label: "Count", type: "number", required: false, defaultValue: "0" },
  ],
  requirements: { skills: ["Review"], mcpServers: ["Docs"], workspace: true, webSearch: false },
  outputFormat: "markdown",
  projectId: "synthetic-project",
};
function rejects(action: () => unknown) {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error instanceof Error).toBe(true);
}

test("recipe rendering treats values as literal data and validates named numeric inputs", () => {
  const parsed = validateRecipeSpec(spec);
  const literal = `\${process.env.KEY} {{count}} $&`;
  const rendered = renderRecipePrompt(parsed, { file: literal });
  expect(rendered.values).toEqual({ file: literal, count: 0 });
  expect(rendered.prompt.includes(literal)).toBe(true);
  expect(renderRecipePrompt(parsed, { file: "a.csv", count: "2.5" }).values.count).toBe(2.5);
  for (const values of [
    {},
    { file: "a", unexpected: "x" },
    { file: "a", count: "1+2" },
    { file: "a", count: Infinity },
  ])
    rejects(() => renderRecipePrompt(parsed, values));
});

test("invalid placeholders and prototype keys are rejected rather than evaluated", () => {
  for (const promptTemplate of [
    "{{missing}}",
    "{{file.toString()}}",
    "{{constructor}}",
    "{{{file}}}",
  ])
    rejects(() => validateRecipeSpec({ ...spec, promptTemplate }));
  rejects(() =>
    validateRecipeSpec({
      ...spec,
      parameters: [{ key: "__proto__", label: "bad", type: "text", required: true }],
    }),
  );
  rejects(() =>
    renderRecipePrompt(
      validateRecipeSpec(spec),
      JSON.parse('{"file":"a","__proto__":{"polluted":true}}'),
    ),
  );
  expect(({} as { polluted?: boolean }).polluted).toBe(undefined);
});

test("capability checks use configured names, preserve missing details and do not claim connection health", () => {
  const parsed = validateRecipeSpec(spec);
  expect(
    missingRecipeCapabilities(parsed.requirements, {
      skills: ["review"],
      mcpServers: ["docs"],
      workspace: true,
      webSearch: true,
    }),
  ).toEqual([]);
  expect(
    missingRecipeCapabilities(parsed.requirements, {
      skills: [],
      mcpServers: [],
      workspace: false,
      webSearch: false,
    }),
  ).toEqual(["skill:Review", "mcp:Docs", "workspace"]);
});
