// DynamoDB store (single table). It talks to a small "table" object (see dynamo-adapter.mjs)
// so the logic can be tested without AWS.
//
//   pk            sk                 what
//   F#<fid>       META               freelancer
//   F#<fid>       C#<cid>            client
//   E#<email>     META               email -> freelancer id (enforces unique emails)
//   T#<token>     META               client link token -> freelancer id + client id
//   M#<cid>       <time>#<id>        message
//   S#<hash>      META               login session (ttl)
//   R#<hash>      META               password reset token (ttl)
const strip = (x) => {
  if (!x) return undefined;
  const { pk, sk, ttl, ...rest } = x;
  return rest;
};
const ttl = (ms) => Math.floor(ms / 1000) + 3600; // DynamoDB deletes expired rows lazily, so code still checks expiry
const pad = (n) => String(n).padStart(15, "0");

export function createDynamoStore(table) {
  return {
    async freelancerByEmail(email) {
      const idx = await table.get(`E#${email}`, "META");
      return idx ? this.freelancerById(idx.freelancerId) : undefined;
    },
    async freelancerById(id) { return strip(await table.get(`F#${id}`, "META")); },
    async addFreelancer(f) {
      const ok = await table.put({ pk: `E#${f.email}`, sk: "META", freelancerId: f.id }, { ifNotExists: true });
      if (!ok) return null;
      await table.put({ pk: `F#${f.id}`, sk: "META", ...f });
      return f;
    },
    async saveFreelancer(f) { await table.put({ pk: `F#${f.id}`, sk: "META", ...f }); },

    async addSession(s) { await table.put({ pk: `S#${s.id}`, sk: "META", ...s, ttl: ttl(s.expires) }); },
    async session(id) {
      const s = strip(await table.get(`S#${id}`, "META"));
      return s && s.expires > Date.now() ? s : undefined;
    },
    async dropSession(id) { await table.del(`S#${id}`, "META"); },

    async clientsOf(fid) { return (await table.query(`F#${fid}`, "C#")).map(strip); },
    async allClients() { return (await table.scan("C#")).map(strip); }, // fine at small scale; add an index if you reach thousands
    async clientById(fid, id) { return strip(await table.get(`F#${fid}`, `C#${id}`)); },
    async clientByToken(token) {
      const idx = await table.get(`T#${token}`, "META");
      return idx ? this.clientById(idx.freelancerId, idx.clientId) : undefined;
    },
    async addClient(c) {
      await table.put({ pk: `T#${c.token}`, sk: "META", freelancerId: c.freelancerId, clientId: c.id });
      await table.put({ pk: `F#${c.freelancerId}`, sk: `C#${c.id}`, ...c });
      return c;
    },
    async saveClient(c) { await table.put({ pk: `F#${c.freelancerId}`, sk: `C#${c.id}`, ...c }); },
    async deleteClient(fid, id) {
      const c = await this.clientById(fid, id);
      if (!c) return;
      await table.del(`T#${c.token}`, "META");
      await table.del(`F#${fid}`, `C#${id}`);
      for (const m of await table.query(`M#${id}`, "")) await table.del(m.pk, m.sk);
    },

    async messagesOf(clientId) { return (await table.query(`M#${clientId}`, "")).map(strip); },
    async addMessage(m) { await table.put({ pk: `M#${m.clientId}`, sk: `${pad(m.at)}#${m.id}`, ...m }); return m; },

    async putReset(r) { await table.put({ pk: `R#${r.hash}`, sk: "META", ...r, ttl: ttl(r.expires) }); },
    async takeReset(hash) {
      const old = strip(await table.del(`R#${hash}`, "META", { returnOld: true })); // delete + read in one step: single use
      return old && old.expires > Date.now() ? old : undefined;
    },
  };
}
