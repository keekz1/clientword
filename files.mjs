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
    async size(key) { try { return fs.statSync(at(key)).size; } catch { return 0; } },
    async presignPut() { return null; }, // no direct upload locally: the browser posts to the server
    async presignGet() { return null; },
    _count: () => { let n = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : n++; }; walk(root); return n; },
  };
}

export async function createS3Files({ bucket, region }) {
  const s3 = await import("@aws-sdk/client-s3");
  const client = new s3.S3Client({ region });
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
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
    async size(key) {
      try { return (await client.send(new s3.HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentLength || 0; }
      catch (e) { if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) return 0; throw e; }
    },
    // Browser uploads straight to S3 with a link that works for 5 minutes, for exactly this key and size
    async presignPut(key, size) {
      const url = await getSignedUrl(client, new s3.PutObjectCommand({ Bucket: bucket, Key: key, ContentLength: size }), { expiresIn: 300, signableHeaders: new Set(["content-length"]) });
      return { url, headers: {} };
    },
    // Downloads are forced to save as a file, never rendered by the browser
    async presignGet(key, filename) {
      return getSignedUrl(client, new s3.GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: `attachment; filename="${filename}"`, ResponseContentType: "application/octet-stream" }), { expiresIn: 60 });
    },
  };
}
