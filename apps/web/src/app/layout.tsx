import type { Metadata } from "next";
import Script from "next/script";
import "ui/styles/tokens.css";
import "./globals.css";
import { AppProviders } from "@/components/providers/AppProviders";
import { ThemeListener } from "@/components/theme/ThemeListener";
import { THEME_MODE_STORAGE_KEY } from "@/components/theme/theme";
import { Toaster } from "../components/ui/sonner";

export const metadata: Metadata = {
  title: "OpenHorn",
  description: "AI Assistant",
};

const themeScript = `
(() => {
  try {
    const key = ${JSON.stringify(THEME_MODE_STORAGE_KEY)};
    const mode = localStorage.getItem(key) || 'light';
    const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const useDark = mode === 'dark' || (mode === 'system' && systemDark);
    const root = document.documentElement;
    if (useDark) root.classList.add('dark');
    else root.classList.remove('dark');
  } catch {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Script id="theme-init" strategy="beforeInteractive">
          {themeScript}
        </Script>
        <AppProviders>
          {children}
          <Toaster />
          <ThemeListener />
        </AppProviders>
      </body>
    </html>
  );
}
