import type { NextConfig } from "next";
const config: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "pg"],
  async redirects() {
    if (process.env.VERCEL_ENV !== "production") return [];
    const url = process.env.ROCKET_DASHBOARD_URL;
    if (!url) return [];
    const canonical = new URL(url);
    if (canonical.protocol !== "https:") return [];
    const missing = [
      { type: "host" as const, value: canonical.hostname.replaceAll(".", "\\.") },
    ];
    return [
      {
        source: "/",
        missing,
        destination: `${canonical.origin}/`,
        permanent: false,
      },
      {
        source: "/:page(home|dashboard|mt5|settings|analysis|account|billing|owner)",
        missing,
        destination: `${canonical.origin}/:page`,
        permanent: false,
      },
    ];
  },
  outputFileTracingIncludes: {
    "/api/mt5/*": [
      "./ea/ROCKET1000_EA.ex5",
      "./ea/ROCKET1000_EA.mq5",
      "./ea/build-manifest.json",
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};
export default config;
