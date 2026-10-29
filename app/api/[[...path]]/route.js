// Every /api/* request is handled by the shared core (core.mjs). Pages are plain files in /public.
import { getHandler } from "../../../runtime.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function run(request) {
  const handle = await getHandler();
  return handle(request);
}
export { run as GET, run as POST, run as PUT, run as PATCH, run as DELETE };
