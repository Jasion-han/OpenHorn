"use client";

import { create } from "zustand";
import { getBackendBase } from "../lib/backendBase";

export type BackendStatus = "unknown" | "ok" | "down";

export const HEALTH_URL = `${getBackendBase()}/`;
export const BACKEND_UP_EVENT = "openhorn:backend-up";

interface BackendStatusState {
  status: BackendStatus;
  lastError: string | null;
  lastDownAt: number | null;
  lastUpAt: number | null;
  markDown: (message: string) => void;
  markUp: () => void;
  retry: () => Promise<boolean>;
}

export const useBackendStatusStore = create<BackendStatusState>((set, get) => ({
  status: "unknown",
  lastError: null,
  lastDownAt: null,
  lastUpAt: null,
  markDown: (message) => {
    const now = Date.now();
    set({
      status: "down",
      lastError: message,
      lastDownAt: now,
    });
  },
  markUp: () => {
    const now = Date.now();
    set({
      status: "ok",
      lastError: null,
      lastUpAt: now,
    });
  },
  retry: async () => {
    try {
      const res = await fetch(HEALTH_URL, { method: "GET", cache: "no-store" });
      if (!res.ok) {
        get().markDown(`Health check failed (${res.status})`);
        return false;
      }
      get().markUp();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(BACKEND_UP_EVENT));
      }
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Failed to fetch";
      const mixedContent =
        typeof window !== "undefined" &&
        window.location.protocol === "https:" &&
        HEALTH_URL.startsWith("http:");
      if (mixedContent) {
        get().markDown("Blocked by browser (mixed content)");
        return false;
      }

      if (typeof window !== "undefined") {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1200);
        try {
          await fetch(HEALTH_URL, {
            method: "GET",
            mode: "no-cors",
            cache: "no-store",
            signal: controller.signal,
          });
          get().markDown("Blocked by browser (CORS?)");
          return false;
        } catch {
          // ignore
        } finally {
          clearTimeout(timeout);
        }
      }

      get().markDown(msg);
      return false;
    }
  },
}));
