// The implementation lives in `shared/child-env` so the sidecar and the
// server-side bash tool strip the same secrets. Re-exported here to keep
// existing import paths stable.
export { sanitizeChildEnv } from "shared/child-env";
