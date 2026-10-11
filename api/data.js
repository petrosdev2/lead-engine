// GET  /api/data            -> { sets: { docId: { leads } }, settings }
// POST /api/data { op, … }  -> set | update | remove | settings | clear
import { requireUser, readBody, readJSON, writeJSON, mutateJSON, listDocs, removeDoc, send, fail } from './_lib.js';

const DOC = /^[A-Za-z0-9_-]{1,80}$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function merge(t, p) {
  Object.keys(p).forEach((k) => {
    const v = p[k];
    if (isObj(v) && isObj(t[k])) merge(t[k], v); else t[k] = v;
  });
  return t;
}

export default async function handler(req, res) {
  try {
    if (!(await requireUser(req, res))) return;
    if (req.method === 'GET') {
      const names = (await listDocs('leadsets/')).filter((p) => p.endsWith('.json'));
      const docs = await Promise.all(names.map((p) => readJSON(p)));
      const sets = {};
      names.forEach((p, i) => { if (docs[i]) sets[p.slice('leadsets/'.length, -5)] = docs[i].data; });
      const cfg = await readJSON('config/main.json');
      return send(res, 200, { sets, settings: cfg ? cfg.data : null });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
    const b = await readBody(req);
    if (!b) return send(res, 400, { error: 'Send JSON.' });

    if (b.op === 'settings') {
      if (!isObj(b.settings)) return send(res, 400, { error: 'Settings are missing.' });
      await writeJSON('config/main.json', b.settings);
      return send(res, 200, { ok: true });
    }
    if (b.op === 'clear') {
      const names = await listDocs('leadsets/');
      await Promise.all(names.map((p) => removeDoc(p)));
      return send(res, 200, { ok: true });
    }
    if (!DOC.test(String(b.doc || ''))) return send(res, 400, { error: 'Bad document name.' });
    const path = 'leadsets/' + b.doc + '.json';

    if (b.op === 'set') {
      if (!isObj(b.leads)) return send(res, 400, { error: 'Leads are missing.' });
      await writeJSON(path, { leads: b.leads });
      return send(res, 200, { ok: true });
    }
    if (b.op === 'update' || b.op === 'remove') {
      const id = String(b.id || '');
      if (!id || id === '__proto__') return send(res, 400, { error: 'Lead id is missing.' });
      if (b.op === 'update' && !isObj(b.patch)) return send(res, 400, { error: 'Nothing to change.' });
      const out = await mutateJSON(path, (doc) => {
        doc.leads = isObj(doc.leads) ? doc.leads : {};
        if (b.op === 'remove') delete doc.leads[id];
        else if (isObj(doc.leads[id])) merge(doc.leads[id], b.patch);
        return doc;
      });
      return out ? send(res, 200, { ok: true }) : send(res, 404, { error: 'That lead is no longer stored.' });
    }
    return send(res, 400, { error: 'Unknown request.' });
  } catch (e) { fail(res, e); }
}
