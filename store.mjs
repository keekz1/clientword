import { createLocalStore } from "./store-local.mjs";
import { createDynamoStore } from "./store-dynamo.mjs";
import { createLocalFiles, createS3Files } from "./files.mjs";
import { createMemoryLimiter, createTableLimiter } from "./limiter.mjs";

export async function createBackends(config) {
  if (config.storeKind === "dynamo") {
    const { createDynamoTable } = await import("./dynamo-adapter.mjs");
    const table = await createDynamoTable({ tableName: config.table, region: config.region });
    return {
      store: createDynamoStore(table),
      files: await createS3Files({ bucket: config.bucket, region: config.region }),
      limiter: createTableLimiter(table),
    };
  }
  return { store: createLocalStore(config.dataDir), files: createLocalFiles(config.dataDir), limiter: createMemoryLimiter() };
}
