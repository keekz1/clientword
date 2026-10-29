import { createLocalStore } from "./store-local.mjs";
import { createDynamoStore } from "./store-dynamo.mjs";
import { createLocalFiles, createS3Files } from "./files.mjs";

export async function createBackends(config) {
  if (config.storeKind === "dynamo") {
    const { createDynamoTable } = await import("./dynamo-adapter.mjs");
    return {
      store: createDynamoStore(await createDynamoTable({ tableName: config.table, region: config.region })),
      files: await createS3Files({ bucket: config.bucket, region: config.region }),
    };
  }
  return { store: createLocalStore(config.dataDir), files: createLocalFiles(config.dataDir) };
}
