import { securityHeaders } from "./security.mjs";

// Browsers upload files straight to this S3 address, so the CSP must allow it.
const bucket = process.env.BUCKET || "";
const region = process.env.APP_REGION || process.env.AWS_REGION || "eu-west-2";
const uploadOrigin = bucket ? `https://${bucket}.s3.${region}.amazonaws.com` : "";

const asList = (h) => Object.entries(h).map(([key, value]) => ({ key, value }));

/** @type {import('next').NextConfig} */
export default {
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: asList(securityHeaders({ production: true, uploadOrigin })) },
      // Private links (client pages, reset and verify links, the dashboard) stay out of search engines
      { source: "/(app|reset|verify|app.html|reset.html|verify.html|client.html)", headers: [{ key: "x-robots-tag", value: "noindex, nofollow" }] },
      { source: "/c/:token", headers: [{ key: "x-robots-tag", value: "noindex, nofollow" }, { key: "cache-control", value: "no-store" }] },
    ];
  },
  async rewrites() {
    return [
      { source: "/", destination: "/index.html" },
      { source: "/app", destination: "/app.html" },
      { source: "/reset", destination: "/reset.html" },
      { source: "/verify", destination: "/verify.html" },
      { source: "/privacy", destination: "/privacy.html" },
      { source: "/terms", destination: "/terms.html" },
      { source: "/c/:token", destination: "/client.html" },
    ];
  },
};
