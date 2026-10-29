// Local development store: one JSON file. Same async interface as store-dynamo.mjs.
import fs from "node:fs";
import path from "node:path";

export function createLocalStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const FILE = path.join(dir, "db.json");
  let db = { freelancers: [], clients: [], sessions: [], messages: [], resets: [] };
  if (fs.existsSync(FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  const save = () => {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE); // atomic: a crash never leaves a half-written file
  };
  const copy = (x) => (x ? structuredClone(x) : x);

  return {
    async freelancerByEmail(email) { return copy(db.freelancers.find((f) => f.email === email)); },
    async freelancerById(id) { return copy(db.freelancers.find((f) => f.id === id)); },
    async addFreelancer(f) {
      if (db.freelancers.some((x) => x.email === f.email)) return null; // email already used
      db.freelancers.push(copy(f)); save(); return copy(f);
    },
    async saveFreelancer(f) {
      const i = db.freelancers.findIndex((x) => x.id === f.id);
      if (i >= 0) { db.freelancers[i] = copy(f); save(); }
    },

    async addSession(s) { db.sessions = db.sessions.filter((x) => x.expires > Date.now()); db.sessions.push(copy(s)); save(); },
    async session(id) { return copy(db.sessions.find((s) => s.id === id && s.expires > Date.now())); },
    async dropSession(id) { db.sessions = db.sessions.filter((s) => s.id !== id); save(); },

    async clientsOf(fid) { return db.clients.filter((c) => c.freelancerId === fid).map(copy); },
    async allClients() { return db.clients.map(copy); },
    async clientById(fid, id) { return copy(db.clients.find((c) => c.id === id && c.freelancerId === fid)); },
    async clientByToken(token) { return copy(db.clients.find((c) => c.token === token)); },
    async addClient(c) { db.clients.push(copy(c)); save(); return copy(c); },
    async saveClient(c) {
      const i = db.clients.findIndex((x) => x.id === c.id);
      if (i >= 0) { db.clients[i] = copy(c); save(); }
    },
    async deleteClient(fid, id) {
      db.clients = db.clients.filter((c) => !(c.id === id && c.freelancerId === fid));
      db.messages = db.messages.filter((m) => m.clientId !== id);
      save();
    },

    async messagesOf(clientId) { return db.messages.filter((m) => m.clientId === clientId).sort((a, b) => a.at - b.at).map(copy); },
    async addMessage(m) { db.messages.push(copy(m)); save(); return copy(m); },

    async putReset(r) { db.resets = db.resets.filter((x) => x.expires > Date.now()); db.resets.push(copy(r)); save(); },
    async takeReset(hash) {
      const r = db.resets.find((x) => x.hash === hash && x.expires > Date.now());
      db.resets = db.resets.filter((x) => x.hash !== hash); save();
      return copy(r);
    },
  };
}
