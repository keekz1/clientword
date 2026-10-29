// File storage for client uploads: local disk in development, S3 on AWS.
import fs from "node:fs";
import path from "node:path";

export function createLocalFiles(dir) {
  const root = path.join(dir, "uploads");
  fs.mkdirSync(root, { recursive: true });
  const at = (key) => {
    const full = path.join(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error("bad key");
    return full;
  };
  return {
    async put(key, buf) { fs.mkdirSync(path.dirname(at(key)), { recursive: true }); fs.writeFileSync(at(key), buf); },
    async get(key) { try { return fs.readFileSync(at(key)); } catch { return null; } },
    async del(key) { fs.rmSync(at(key), { force: true }); },
    _count: () => { let n = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : n++; }; walk(root); return n; },
  };
}

export async function createS3Files({ bucket, region }) {
  const s3 = await import("@aws-sdk/client-s3");
  const client = new s3.S3Client({ region });
  return {
    async put(key, buf) { await client.send(new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ServerSideEncryption: "AES256" })); },
    async get(key) {
      try {
        const r = await client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }));
        return Buffer.from(await r.Body.transformToByteArray());
      } catch (e) {
        if (e.name === "NoSuchKey") return null;
        throw e;
      }
    },
    async del(key) { await client.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: key })); },
  };
}
