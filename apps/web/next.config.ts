import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone', // enables minimal production image (no node_modules copy needed)
};

export default nextConfig;
