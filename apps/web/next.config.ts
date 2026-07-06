import type { NextConfig } from "next";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const nextConfig: NextConfig = {
  // Keep development and production outputs isolated.
  // Otherwise running `next build` while a local `next dev` server is alive can
  // corrupt the active dev chunk manifest and trigger ChunkLoadError.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  // Only the workspace packages web actually imports. `agent` is a dead
  // (empty) package and `db` is not a web dependency — both were transpile
  // no-ops that misrepresented the dependency graph.
  transpilePackages: ["ui", "shared"],
  experimental: {
    devtoolSegmentExplorer: false,
  },
  webpack: (config, { dev, isServer }) => {
    // IMPORTANT:
    // Next dev uses hashed asset names and internal manifests to guarantee CSS/JS consistency during HMR.
    // Overriding filenames in dev can intermittently break CSS injection (appears as "no styles").
    //
    // If you *really* need stable filenames in dev (e.g. special desktop runtime), opt-in explicitly.
    const stableDevAssets = process.env.OPENHORN_STABLE_DEV_ASSETS === "1";
    if (stableDevAssets && dev && !isServer && config.output) {
      config.output.filename = "static/chunks/[name].js";
      config.output.chunkFilename = "static/chunks/[name].js";
    }

    if (stableDevAssets && dev && !isServer && Array.isArray(config.plugins)) {
      for (const plugin of config.plugins) {
        if (!isRecord(plugin)) continue;
        const ctor = plugin.constructor;
        if (!ctor || typeof ctor !== "function" || ctor.name !== "MiniCssExtractPlugin") continue;
        if (!("options" in plugin)) continue;
        const opts = (plugin as { options?: unknown }).options;
        if (!isRecord(opts)) continue;
        opts.filename = "static/css/[name].css";
        opts.chunkFilename = "static/css/[name].css";
      }
    }

    return config;
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
};

export default nextConfig;
