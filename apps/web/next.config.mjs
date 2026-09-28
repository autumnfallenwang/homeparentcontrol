/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: "../../",
  // Compile the shared workspace package (it ships TS source, no build step).
  transpilePackages: ["@hpc/contract"],
  // The old pages moved into Settings › Children & devices; bookmarks and the
  // installer instructions still point at them. Temporary (307), so the paths
  // stay free to mean something else later.
  async redirects() {
    return [
      { source: "/settings", destination: "/settings/children", permanent: false },
      { source: "/devices", destination: "/settings/children", permanent: false },
      { source: "/setup", destination: "/settings/children", permanent: false },
    ];
  },
  webpack: (config) => {
    // Resolve `.js` specifiers to their `.ts`/`.tsx` source. The contract package
    // uses NodeNext-style `.js` import extensions; webpack needs this alias to
    // map them onto the actual TypeScript files.
    //
    // Load-bearing: without it `next build` fails on @hpc/contract's `.js`
    // imports while `tsc --noEmit` stays green, so typecheck will not catch it.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".jsx": [".tsx", ".jsx"],
    };
    return config;
  },
};

export default nextConfig;
