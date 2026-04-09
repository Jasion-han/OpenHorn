export type CommandRisk = {
  level: "allow" | "confirm";
  reason?: string;
};

/**
 * Allow-list of binaries that are deterministic, side-effect-free, do
 * not access the network, do not modify the filesystem, and do not
 * spawn arbitrary child processes.
 *
 * Anything not on this list is treated as "needs explicit approval".
 *
 * The list is intentionally narrow. We would rather pop an approval
 * dialog for `npm test` than silently let an attacker exfiltrate data
 * because we couldn't classify the command.
 */
const SAFE_BINARIES: ReadonlySet<string> = new Set([
  "pwd",
  "echo",
  "true",
  "false",
  "whoami",
  "id",
  "date",
  "hostname",
  "uname",
  "printenv",
  "env",
  "which",
  "type",
  "command",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "basename",
  "dirname",
  "realpath",
]);

/**
 * Substrings that, if present anywhere in the raw command, immediately
 * push the command to "confirm". These cover shell features that can
 * compose arbitrary follow-up commands or redirect I/O outside our
 * scrutiny.
 */
const COMPOUND_OR_REDIRECT_TOKENS = [
  "$(",
  "${",
  "`",
  ">",
  "<",
  "|",
  "&",
  ";",
  "\n",
  "\r",
  "#",
] as const;

/**
 * Argument flags / patterns that are unsafe even on otherwise-safe
 * binaries (e.g. `find -exec`, `cat -`, `env VAR=value command`).
 */
const UNSAFE_ARG_PATTERNS: ReadonlyArray<RegExp> = [
  /^-exec(dir)?$/i, // find -exec / -execdir
  /^--exec$/i,
  /^-delete$/i, // find -delete
  /^-fprintf?$/i, // find -fprint / -fprintf
  /^-print0$/i, // pipes into xargs typically
  /^--no-preserve-root$/i,
];

function looksLikePath(arg: string): boolean {
  return arg.startsWith("/") || arg.startsWith("~") || arg.includes("..");
}

function startsWithEnvAssignment(token: string): boolean {
  // env VAR=value command  →  the parser would see `env` as binary, but
  // `env VAR=value command` actually executes `command`. We refuse to
  // allow `env` with any arguments at all to avoid this attack.
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

export function classifyBashCommandRisk(command: string): CommandRisk {
  const raw = command.trim();
  if (!raw) return { level: "confirm", reason: "Empty command" };

  // Reject anything that uses compound shell syntax outright. We do not
  // try to parse pipelines, command substitution, or redirects: any of
  // those features can hide an arbitrary command behind a deceptively
  // safe-looking front token.
  for (const tok of COMPOUND_OR_REDIRECT_TOKENS) {
    if (raw.includes(tok)) {
      return { level: "confirm", reason: `Uses shell syntax: ${tok}` };
    }
  }

  // Tokenize on whitespace. This is fine because we already rejected
  // compound syntax above; what's left is `binary arg arg arg`.
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { level: "confirm", reason: "Empty command" };
  }

  const binary = tokens[0] ?? "";
  const args = tokens.slice(1);

  // Reject inline env-var assignments before the binary, e.g.
  // `FOO=bar pwd`. Even if `pwd` itself is safe, we don't want to
  // normalize that surface area here.
  if (startsWithEnvAssignment(binary)) {
    return { level: "confirm", reason: "Inline env assignment" };
  }

  // Strip a possible leading "command" / "type" / "which" wrapper if
  // someone tries `which rm` — those wrappers are themselves safe and
  // don't execute their target. They are already in SAFE_BINARIES, so
  // they fall through naturally.

  // Refuse if the binary is not on the allow-list.
  // Note: we deliberately do NOT consult $PATH or check the binary
  // against /usr/bin/<x>; we match by literal token to avoid being
  // fooled by `bin/echo` or `./echo`.
  if (!SAFE_BINARIES.has(binary)) {
    return { level: "confirm", reason: `Binary not in allow-list: ${binary}` };
  }

  // env with no arguments is fine (just dumps env vars). env with any
  // arguments is dangerous because `env command...` runs `command`.
  if (binary === "env" && args.length > 0) {
    return { level: "confirm", reason: "env with arguments runs a target binary" };
  }

  // For each argument, screen out absolute paths, parent traversal, and
  // unsafe flags. We also reject `~` because shells would expand it to
  // the user's home directory, which is outside the workspace.
  for (const arg of args) {
    for (const pattern of UNSAFE_ARG_PATTERNS) {
      if (pattern.test(arg)) {
        return {
          level: "confirm",
          reason: `Unsafe argument: ${arg}`,
        };
      }
    }
    if (startsWithEnvAssignment(arg)) {
      return { level: "confirm", reason: "Inline env assignment" };
    }
    if (looksLikePath(arg)) {
      return { level: "confirm", reason: `Path argument escapes workspace: ${arg}` };
    }
  }

  return { level: "allow" };
}
