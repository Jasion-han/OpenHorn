// The implementation lives in `shared/shell-risk` so the sidecar runtimes and
// the server-side agent classify commands identically. Re-exported here to keep
// existing import paths stable.
export { type CommandRisk, classifyBashCommandRisk } from "shared/shell-risk";
