// Storage layer. The server only talks to these functions, so swapping the JSON
// file for DynamoDB later means rewriting this one file (same function names).
import fs from "node:fs";
import path from "node:path";

const DIR = process.env.PORTAL_DATA || path.join(import.meta.dirname, "data");
const FILE = path.join(DIR, "db.json");
export const UPLOADS = path.join(DIR, "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });

let db = { freelancers: [], clients: [], sessions: [] };
if (fs.existsSync(FILE)) db = JSON.parse(fs.readFileSync(FILE, "utf8"));

function save() {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE); // atomic, so a crash never leaves a half-written file
}

export const store = {
  freelancerByEmail: (email) => db.freelancers.find((f) => f.email === email),
  freelancerById: (id) => db.freelancers.find((f) => f.id === id),
  addFreelancer(f) { db.freelancers.push(f); save(); return f; },
  updateFreelancer(f) { save(); return f; },

  addSession(s) { db.sessions.push(s); save(); },
  session: (token) => db.sessions.find((s) => s.token === token && s.expires > Date.now()),
  dropSession(token) { db.sessions = db.sessions.filter((s) => s.token !== token); save(); },

  clientsOf: (fid) => db.clients.filter((c) => c.freelancerId === fid),
  clientById: (fid, id) => db.clients.find((c) => c.id === id && c.freelancerId === fid),
  clientByToken: (token) => db.clients.find((c) => c.token === token),
  addClient(c) { db.clients.push(c); save(); return c; },
  updateClient(c) { save(); return c; },
  deleteClient(fid, id) {
    db.clients = db.clients.filter((c) => !(c.id === id && c.freelancerId === fid));
    save();
  },
};
