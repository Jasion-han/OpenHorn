import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

declare const Bun: {
  Transpiler: new (options: { loader: "tsx" }) => { transformSync(source: string): string };
};

// Execute the actual component handlers without a browser or native-window claim.
// Dependencies are passed explicitly; no MCP connection or model call is made.
const source = readFileSync(new URL("./McpSettings.tsx", import.meta.url), "utf8");
const infer = source.slice(
  source.indexOf("function inferMcpType("),
  source.indexOf("export function McpSettings("),
);
const transpiler = new Bun.Transpiler({ loader: "tsx" });

async function invoke(kind: "create" | "update", config: string) {
  const start = source.indexOf(
    `  const ${kind === "create" ? "handleCreateMcp" : "handleUpdateMcp"} =`,
  );
  const end =
    kind === "create"
      ? source.indexOf("  const handleDeleteMcp", start)
      : source.indexOf("  // Default-select", start);
  const handler = kind === "create" ? "handleCreateMcp" : "handleUpdateMcp";
  const errors: string[][] = [];
  const calls: unknown[] = [];
  const busy: boolean[] = [];
  const noop = () => {};
  const scope = {
    mcpName: "fixture",
    mcpServers: [],
    mcpConfig: config,
    editTarget: { id: "fixture-id" },
    editName: "fixture",
    editConfig: config,
    notifyError: (...args: string[]) => errors.push(args),
    notifySuccess: noop,
    getMcpLabel: (key: string) => key,
    setLoading: (value: boolean) => busy.push(value),
    setEditSaving: (value: boolean) => busy.push(value),
    setMcpModalOpen: noop,
    setMcpName: noop,
    setMcpConfig: noop,
    setEditTarget: noop,
    loadServers: async () => {},
    api: {
      mcp: {
        createServer: async (input: unknown) => {
          calls.push(input);
        },
        updateServer: async (_id: string, input: unknown) => {
          calls.push(input);
        },
      },
    },
  };
  const build = new Function(
    "scope",
    transpiler.transformSync(`
    const { ${Object.keys(scope).join(", ")} } = scope;
    ${infer}
    ${source.slice(start, end)}
    return ${handler};
  `),
  ) as (scope: unknown) => () => Promise<void>;
  await build(scope)();
  return { errors, calls, busy };
}

for (const kind of ["create", "update"] as const) {
  test(`${kind} MCP locally rejects parsed null/array/scalars before API or busy state`, async () => {
    for (const config of ["null", "[]", '"scalar"', "42", "false", "true"]) {
      const result = await invoke(kind, config);
      expect(result.calls).toHaveLength(0);
      expect(result.busy).toHaveLength(0);
      expect(result.errors).toEqual([
        ["settings.mcp.invalidConfigTitle", "settings.mcp.invalidConfigObject"],
      ]);
    }
  });
  test(`${kind} MCP keeps valid JSON objects and existing syntax-error behavior`, async () => {
    for (const config of ["{}", '{"command":"openhorn-qa-do-not-execute"}']) {
      const result = await invoke(kind, config);
      expect(result.errors).toHaveLength(0);
      expect(result.calls).toHaveLength(1);
    }
    const invalid = await invoke(kind, "{broken");
    expect(invalid.calls).toHaveLength(0);
    expect(invalid.errors).toHaveLength(1);
  });
}
