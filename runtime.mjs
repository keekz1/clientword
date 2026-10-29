// Builds the app once per server instance and reuses it. Used by the Next.js route handler.
import { loadConfig, checkProduction } from "./config.mjs";
import { createBackends } from "./store.mjs";
import { createMailer } from "./mail.mjs";
import { createHandler } from "./core.mjs";

let ready;
export function getHandler() {
  ready ??= (async () => {
    // Amplify's server code runs on Lambda; never fall back to local-disk storage there
    const env = process.env.AWS_LAMBDA_FUNCTION_NAME ? { ...process.env, NODE_ENV: "production" } : process.env;
    const config = loadConfig(env);
    checkProduction(config);
    const { store, files, limiter } = await createBackends(config);
    return createHandler({ config, store, files, limiter, mailer: createMailer(config) });
  })().catch((e) => { ready = undefined; console.error("Clientword failed to start:", e.message); throw e; });
  return ready;
}
