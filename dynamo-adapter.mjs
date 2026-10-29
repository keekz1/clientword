// Thin wrapper over the AWS SDK. Kept tiny on purpose: all logic lives in store-dynamo.mjs.
// Needs @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb (installed by `npm install`).
export async function createDynamoTable({ tableName, region }) {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const lib = await import("@aws-sdk/lib-dynamodb");
  const doc = lib.DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
  const T = tableName;

  async function all(cmd) {
    const items = [];
    let key;
    do {
      const r = await doc.send(new cmd.Ctor({ ...cmd.input, ExclusiveStartKey: key }));
      items.push(...(r.Items || []));
      key = r.LastEvaluatedKey;
    } while (key);
    return items;
  }

  return {
    async put(item, { ifNotExists = false } = {}) {
      try {
        await doc.send(new lib.PutCommand({ TableName: T, Item: item, ...(ifNotExists ? { ConditionExpression: "attribute_not_exists(pk)" } : {}) }));
        return true;
      } catch (e) {
        if (e.name === "ConditionalCheckFailedException") return false;
        throw e;
      }
    },
    async get(pk, sk) { return (await doc.send(new lib.GetCommand({ TableName: T, Key: { pk, sk } }))).Item; },
    async query(pk, skPrefix) {
      return all({ Ctor: lib.QueryCommand, input: {
        TableName: T, KeyConditionExpression: skPrefix ? "pk = :p AND begins_with(sk, :s)" : "pk = :p",
        ExpressionAttributeValues: skPrefix ? { ":p": pk, ":s": skPrefix } : { ":p": pk } } });
    },
    async del(pk, sk, { returnOld = false } = {}) {
      const r = await doc.send(new lib.DeleteCommand({ TableName: T, Key: { pk, sk }, ...(returnOld ? { ReturnValues: "ALL_OLD" } : {}) }));
      return r.Attributes;
    },
    async scan(skPrefix) {
      return all({ Ctor: lib.ScanCommand, input: { TableName: T, FilterExpression: "begins_with(sk, :s)", ExpressionAttributeValues: { ":s": skPrefix } } });
    },
  };
}

// In-memory table with the same behaviour, used by tests (and handy for trying the Dynamo code path offline).
export function createMemoryTable() {
  const rows = new Map();
  const k = (pk, sk) => pk + "\u0000" + sk;
  const sorted = (list) => list.sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
  return {
    async put(item, { ifNotExists = false } = {}) {
      if (ifNotExists && rows.has(k(item.pk, item.sk))) return false;
      rows.set(k(item.pk, item.sk), structuredClone(item)); return true;
    },
    async get(pk, sk) { return structuredClone(rows.get(k(pk, sk))); },
    async query(pk, skPrefix) { return sorted([...rows.values()].filter((r) => r.pk === pk && r.sk.startsWith(skPrefix))).map((r) => structuredClone(r)); },
    async del(pk, sk, { returnOld = false } = {}) {
      const old = rows.get(k(pk, sk)); rows.delete(k(pk, sk)); return returnOld ? structuredClone(old) : undefined;
    },
    async scan(skPrefix) { return [...rows.values()].filter((r) => r.sk.startsWith(skPrefix)).map((r) => structuredClone(r)); },
    _size: () => rows.size,
  };
}
