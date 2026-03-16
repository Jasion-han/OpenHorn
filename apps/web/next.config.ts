import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['ui', 'shared', 'agent', 'db'],
  experimental: {
    devtoolSegmentExplorer: false,
  },
  webpack: (config, { dev, isServer }) => {
    // IMPORTANT:
    // Next dev uses hashed asset names and internal manifests to guarantee CSS/JS consistency during HMR.
    // Overriding filenames in dev can intermittently break CSS injection (appears as "no styles").
    //
    // If you *really* need stable filenames in dev (e.g. special desktop runtime), opt-in explicitly.
    const stableDevAssets = process.env.OPENHORN_STABLE_DEV_ASSETS === '1';
    if (stableDevAssets && dev && !isServer && config.output) {
      config.output.filename = 'static/chunks/[name].js';
      config.output.chunkFilename = 'static/chunks/[name].js';
    }

    if (stableDevAssets && dev && !isServer && Array.isArray(config.plugins)) {
      for (const plugin of config.plugins) {
        if ((plugin as any)?.constructor?.name !== 'MiniCssExtractPlugin') continue;
        const opts = (plugin as any).options;
        if (!opts) continue;
        opts.filename = 'static/css/[name].css';
        opts.chunkFilename = 'static/css/[name].css';
      }
    }

    if (dev && isServer && config.output) {
      // Next's server webpack runtime in this repo expects chunks next to `webpack-runtime.js`.
      // Keep the emitted server chunk files aligned with that runtime.
      config.output.chunkFilename = '[id].js';
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
