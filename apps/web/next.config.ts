import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['ui', 'shared', 'agent', 'db'],
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
};

export default nextConfig;
