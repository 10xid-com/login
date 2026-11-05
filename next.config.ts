import type { NextConfig } from "next";
import { CID_COMPANIES, type CidSlug } from "./lib/cid/profile";
import { cidStagePolicy } from "./lib/cid/stage";

const nextConfig: NextConfig = {
  async headers() {
    return (Object.keys(CID_COMPANIES) as CidSlug[]).map(slug => ({
      source: `/auth/cid/${slug}`,
      has: [{ type: "query", key: "stage", value: "1" }],
      headers: [
        { key: "Content-Security-Policy", value: cidStagePolicy(slug) },
        { key: "Cache-Control", value: "private, no-store" },
      ],
    }));
  },
  /**
   * The local hostnames from the README, which development and the browser
   * tests run against.
   *
   * `next dev` refuses its dev assets and live-reload socket to any hostname
   * other than localhost unless it is listed here, and without them no client
   * component hydrates: the account menu never opens, and a textarea takes
   * typing that React never sees. The suite then passes or fails against a
   * page no real browser is ever shown. Development only; a production build
   * ignores this setting.
   */
  allowedDevOrigins: ["*.portal-a.test", "*.portal-b.test"],
};

export default nextConfig;
