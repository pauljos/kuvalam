import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: {
    appIsrStatus: false,
    buildActivityPosition: 'top-right',
  },
  output: 'standalone', // enables minimal production image (no node_modules copy needed)
  typescript: {
    // Don't fail build on type errors in production (vitest.config.ts requires dev dependencies)
    ignoreBuildErrors: true,
  },
  eslint: {
    // Don't fail build on lint errors (we check separately in CI)
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
