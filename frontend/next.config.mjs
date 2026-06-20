import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {};

export default withSentryConfig(nextConfig, {
  org: "ucb-ai-hackathon",
  project: "ucb-ai-hackathon",

  authToken: process.env.SENTRY_AUTH_TOKEN,

  widenClientFileUpload: true,
  // tunnelRoute removed — no backing route; clients ship events directly
  silent: !process.env.CI,
});
