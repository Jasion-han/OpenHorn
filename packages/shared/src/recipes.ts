import type {
  RecipeParameter,
  RecipeRequirements,
  RecipeSpec,
  RecipeValues,
} from "./types/recipes";

export class RecipeValidationError extends Error {
  constructor(
    readonly code: "invalid_recipe" | "invalid_parameters",
    message: string,
  ) {
    super(message);
    this.name = "RecipeValidationError";
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
function invalid(message: string): never {
  throw new RecipeValidationError("invalid_recipe", message);
}
function text(value: unknown, field: string, limit: number, required = false): string {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    value.includes("\0") ||
    (required && !value.trim())
  )
    invalid(`Invalid ${field}`);
  return value;
}
function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, field, 200, true).trim();
}
function names(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 30) invalid(`Invalid ${field}`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const name = text(item, field, 120, true).trim();
    if (!seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      result.push(name);
    }
  }
  return result;
}
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const UNSAFE_KEYS = new Set(["constructor", "prototype", "__proto__"]);
const PLACEHOLDER = /{{\s*([A-Za-z][A-Za-z0-9_]{0,39})\s*}}/g;

export function validateRecipeSpec(value: unknown): RecipeSpec {
  if (!record(value)) invalid("Recipe must be an object");
  const title = text(value.title, "title", 160, true).trim();
  const description = text(value.description ?? "", "description", 2000);
  const promptTemplate = text(value.promptTemplate, "promptTemplate", 64_000, true);
  if (!Array.isArray(value.parameters) || value.parameters.length > 30)
    invalid("Invalid parameters");
  const keys = new Set<string>();
  const parameters: RecipeParameter[] = value.parameters.map((item: unknown) => {
    if (
      !record(item) ||
      typeof item.key !== "string" ||
      !KEY.test(item.key) ||
      UNSAFE_KEYS.has(item.key) ||
      keys.has(item.key)
    )
      invalid("Invalid or duplicate parameter key");
    keys.add(item.key);
    if (item.type !== "text" && item.type !== "multiline" && item.type !== "number")
      invalid("Invalid parameter type");
    if (typeof item.required !== "boolean") invalid("Invalid required flag");
    const parameter: RecipeParameter = {
      key: item.key,
      label: text(item.label, "parameter label", 160, true),
      type: item.type,
      required: item.required,
    };
    if (item.defaultValue !== undefined) {
      parameter.defaultValue = text(item.defaultValue, "defaultValue", 16_000);
      if (item.type === "number") {
        parameter.defaultValue = parameter.defaultValue.trim();
        if (parameter.defaultValue && !Number.isFinite(Number(parameter.defaultValue)))
          invalid("Invalid numeric default");
      }
    }
    return parameter;
  });
  if (promptTemplate.includes("{{{") || promptTemplate.includes("}}}"))
    invalid("Unsupported template expression");
  const remaining = promptTemplate.replace(PLACEHOLDER, (_match, key: string) => {
    if (!keys.has(key)) invalid(`Unknown template parameter: ${key}`);
    return "";
  });
  if (remaining.includes("{{") || remaining.includes("}}"))
    invalid("Unsupported template expression");
  if (!record(value.requirements)) invalid("Invalid requirements");
  const requirements: RecipeRequirements = {
    skills: names(value.requirements.skills, "skills"),
    mcpServers: names(value.requirements.mcpServers, "mcpServers"),
    workspace: value.requirements.workspace === true,
    webSearch: value.requirements.webSearch === true,
  };
  if (
    typeof value.requirements.workspace !== "boolean" ||
    typeof value.requirements.webSearch !== "boolean"
  )
    invalid("Invalid capability flag");
  if (
    value.outputFormat !== "markdown" &&
    value.outputFormat !== "html" &&
    value.outputFormat !== "openui"
  )
    invalid("Invalid output format");
  const projectId = optionalId(value.projectId, "projectId");
  const channelId = optionalId(value.channelId, "channelId");
  const modelId = optionalId(value.modelId, "modelId");
  if (modelId && !channelId) invalid("Model requires a channel");
  return {
    title,
    description,
    promptTemplate,
    parameters,
    requirements,
    outputFormat: value.outputFormat,
    ...(projectId ? { projectId } : {}),
    ...(channelId ? { channelId } : {}),
    ...(modelId ? { modelId } : {}),
  };
}

/** One literal substitution pass. Values cannot introduce executable expressions. */
export function renderRecipePrompt(
  spec: RecipeSpec,
  input: unknown,
): { prompt: string; values: RecipeValues } {
  const fail = (message: string): never => {
    throw new RecipeValidationError("invalid_parameters", message);
  };
  if (!record(input))
    throw new RecipeValidationError("invalid_parameters", "Values must be an object");
  const keys = new Set(spec.parameters.map((parameter) => parameter.key));
  for (const key of Object.keys(input))
    if (!keys.has(key) || UNSAFE_KEYS.has(key)) fail(`Unknown parameter: ${key}`);
  const values: RecipeValues = {};
  for (const parameter of spec.parameters) {
    let value = Object.hasOwn(input, parameter.key) ? input[parameter.key] : parameter.defaultValue;
    if (value === undefined || value === "") {
      if (parameter.required) fail(`Missing parameter: ${parameter.key}`);
      value = "";
    }
    if (typeof value !== "string" && typeof value !== "number")
      fail(`Invalid parameter: ${parameter.key}`);
    if (String(value).length > 16_000 || String(value).includes("\0"))
      fail(`Parameter too large: ${parameter.key}`);
    if (parameter.required && !String(value).trim()) fail(`Missing parameter: ${parameter.key}`);
    if (parameter.type === "number" && value !== "") {
      if (!String(value).trim() || !Number.isFinite(Number(value)))
        fail(`Invalid number: ${parameter.key}`);
      value = Number(value);
    } else if (typeof value !== "string") fail(`Text required: ${parameter.key}`);
    values[parameter.key] = value as string | number;
  }
  const rendered = spec.promptTemplate.replace(PLACEHOLDER, (_match, key: string) =>
    String(values[key] ?? ""),
  );
  if (rendered.length > 100_000) fail("Rendered prompt too large");
  const instructions = {
    markdown: "Return the result as Markdown.",
    html: "Return an interactive HTML fragment in a fenced html-ui block.",
    openui: "Return an OpenUI Lang program in a fenced openui-lang block.",
  };
  return { prompt: `${rendered}\n\n${instructions[spec.outputFormat]}`, values };
}

export function missingRecipeCapabilities(
  requirements: RecipeRequirements,
  available: {
    skills: string[];
    mcpServers: string[];
    workspace: boolean;
    webSearch: boolean;
  },
): string[] {
  const skills = new Set(available.skills.map((name) => name.trim().toLowerCase()));
  const mcpServers = new Set(available.mcpServers.map((name) => name.trim().toLowerCase()));
  return [
    ...requirements.skills
      .filter((name) => !skills.has(name.toLowerCase()))
      .map((name) => `skill:${name}`),
    ...requirements.mcpServers
      .filter((name) => !mcpServers.has(name.toLowerCase()))
      .map((name) => `mcp:${name}`),
    ...(requirements.workspace && !available.workspace ? ["workspace"] : []),
    ...(requirements.webSearch && !available.webSearch ? ["webSearch"] : []),
  ];
}
