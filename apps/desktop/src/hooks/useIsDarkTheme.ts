import { useEffect, useState } from "react";

function getIsDark(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

export function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = useState(getIsDark);

  useEffect(() => {
    const apply = () => setIsDark(getIsDark());
    apply();

    const observer = new MutationObserver(() => apply());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, []);

  return isDark;
}
