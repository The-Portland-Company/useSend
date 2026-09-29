/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
await import("./src/env.js");

/** @type {import("next").NextConfig} */
const config = {
  output: process.env.DOCKER_OUTPUT ? "standalone" : undefined,
  serverExternalPackages: ["bullmq"],
  transpilePackages: ["@usesend/ui", "@usesend/email-editor"],
  // The vendored tpc-auth SDK uses NodeNext-style "./x.js" imports of .ts files.
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".js"] };
    return config;
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "www.gravatar.com",
      },
    ],
  },
};

export default config;
