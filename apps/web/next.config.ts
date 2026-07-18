import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@youni/core", "@youni/db", "@youni/ai"],
  experimental: {
    serverActions: {
      bodySizeLimit: "12mb", // 시안 JPG 업로드
    },
  },
};

export default nextConfig;
