'use client';

import { create } from 'zustand';

export type BackendStatus = 'unknown' | 'ok' | 'down';

export const HEALTH_URL = 'http://localhost:3000/';
export const BACKEND_UP_EVENT = 'openhorn:backend-up';

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
  status: 'unknown',
  lastError: null,
  lastDownAt: null,
  lastUpAt: null,
  markDown: (message) => {
    const now = Date.now();
    set({
      status: 'down',
      lastError: message,
      lastDownAt: now,
    });
  },
  markUp: () => {
    const now = Date.now();
    set({
      status: 'ok',
      lastError: null,
      lastUpAt: now,
    });
  },
  retry: async () => {
    try {
      const res = await fetch(HEALTH_URL, { method: 'GET', cache: 'no-store' });
      if (!res.ok) {
        get().markDown(`Health check failed (${res.status})`);
        return false;
      }
      get().markUp();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(BACKEND_UP_EVENT));
      }
      return true;
    } catch (error) {
      get().markDown(error instanceof Error ? error.message : 'Failed to fetch');
      return false;
    }
  },
}));
