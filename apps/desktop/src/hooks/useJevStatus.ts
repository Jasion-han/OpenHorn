import { useCallback, useEffect, useRef, useState } from "react";
import type { JevStatus } from "shared/types";
import { getDesktopBackendBase } from "../lib/backendBase";
import { decisionApi } from "../lib/decisionApi";
import { useAuthStore } from "../stores/authStore";
import { BACKEND_UP_EVENT } from "../stores/backendStatusStore";

export function useJevStatus() {
  const userId = useAuthStore((state) => state.user?.id ?? "");
  const owner = `${getDesktopBackendBase()}:${userId}`;
  const current = useRef(owner);
  current.current = owner;
  const mounted = useRef(false),
    epoch = useRef(0);
  const [box, setBox] = useState<{ owner: string; status: JevStatus } | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(false);
  const isCurrent = useCallback(() => mounted.current && current.current === owner, [owner]);
  const accept = useCallback(
    (status: JevStatus) => {
      if (!isCurrent()) return;
      epoch.current++;
      setBox({ owner, status });
      setLoading(false);
      setError(false);
    },
    [owner, isCurrent],
  );
  const reload = useCallback(async () => {
    const token = ++epoch.current;
    setLoading(true);
    setError(false);
    try {
      const status = await decisionApi.status();
      if (isCurrent() && token === epoch.current) accept(status);
    } catch {
      if (isCurrent() && token === epoch.current) setError(true);
    } finally {
      if (isCurrent() && token === epoch.current) setLoading(false);
    }
  }, [isCurrent, accept]);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const refresh = () => void reload();
    window.addEventListener(BACKEND_UP_EVENT, refresh);
    return () => {
      mounted.current = false;
      epoch.current++;
      window.removeEventListener(BACKEND_UP_EVENT, refresh);
    };
  }, [reload]);
  return {
    status: box?.owner === owner ? box.status : null,
    loading,
    error,
    reload,
    accept,
    isCurrent,
  };
}
