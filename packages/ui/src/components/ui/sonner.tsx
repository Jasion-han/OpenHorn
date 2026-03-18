"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

function getCurrentTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

const Toaster = ({ toastOptions, style, className, ...props }: ToasterProps) => {
  const [theme, setTheme] = React.useState<"light" | "dark">(() => getCurrentTheme());
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
    const apply = () => setTheme(getCurrentTheme());
    apply();

    const observer = new MutationObserver(() => apply());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, []);

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <Sonner
      theme={theme}
      className={["toaster group z-[9999]", className].filter(Boolean).join(" ")}
      style={{ zIndex: 9999, ...style }}
      toastOptions={{
        ...toastOptions,
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />,
    document.body,
  );
};

export { Toaster };
