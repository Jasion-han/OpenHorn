import { createAuthClient } from "better-auth/react";
import { getDesktopBackendBase } from "./backendBase";

export const authClient = createAuthClient({
  baseURL: getDesktopBackendBase(),
});
