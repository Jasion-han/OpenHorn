// Previously a much weaker blocklist that DEFAULT-ALLOWED anything it did not
// recognise (so `cat ~/.ssh/id_rsa` never prompted for approval). It now shares
// the sidecar's allow-list implementation: anything not provably read-only
// requires explicit approval.
export { type CommandRisk, classifyBashCommandRisk } from "shared/shell-risk";
