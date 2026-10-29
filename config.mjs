import path from "node:path";

// All settings come from environment variables so the same code runs locally and on AWS.
export function loadConfig(env = process.env) {
  const c = {
    port: Number(env.PORT || 3000),
    production: env.NODE_ENV === "production",
    storeKind: env.STORE || "local", // "local" (JSON file) or "dynamo"
    dataDir: env.PORTAL_DATA || path.join(process.cwd(), "data"),
    table: env.TABLE_NAME || "",
    bucket: env.BUCKET || "",
    region: env.APP_REGION || env.AWS_REGION || "eu-west-2", // Amplify reserves AWS_* names, so APP_REGION is the one to set there
    mailKind: env.MAIL || "console", // "console" (dev) or "ses"
    mailFrom: env.MAIL_FROM || "Clientword <no-reply@localhost>",
    appUrl: (env.APP_URL || "").replace(/\/+$/, ""), // public https address, used in emails
    trustProxy: env.TRUST_PROXY === "1", // set behind CloudFront / Amplify / a load balancer
    cronSecret: env.CRON_SECRET || "",
  };
  return c;
}

// Refuse to start in production with settings that would lose data or send broken links.
export function checkProduction(c) {
  if (!c.production) return;
  const problems = [];
  if (c.storeKind !== "dynamo") problems.push("STORE must be 'dynamo' (serverless instances have no lasting disk)");
  if (!c.table) problems.push("TABLE_NAME is required");
  if (!c.bucket) problems.push("BUCKET is required");
  if (!/^https:\/\//.test(c.appUrl)) problems.push("APP_URL must be your public https address");
  if (c.mailKind !== "ses") problems.push("MAIL must be 'ses'");
  if (!c.trustProxy) problems.push("TRUST_PROXY=1 is required on Amplify so rate limits see real client IPs");
  if (problems.length) throw new Error("Bad production config:\n - " + problems.join("\n - "));
}
