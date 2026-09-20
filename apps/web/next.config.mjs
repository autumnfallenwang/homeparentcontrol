/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: "../../",
  // Compile the shared workspace package (it ships TS source, no build step).
  transpilePackages: ["@hpc/contract"],
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
