// GET  /api/auth                      -> { setup, authed, ai }
// POST /api/auth { op, password }     -> setup | login | logout | change
import { getAuth, isSignedIn, sessionCookie, hashPassword, sameText, randomId, readBody, writeJSON, send, fail } from './_lib.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const record = (password) => { const salt = randomId(16); return { salt, hash: hashPassword(password, salt), secret: randomId(32), created: new Date().toISOString() }; };

export default async function handler(req, res) {
  try {
    const auth = await getAuth();
    if (req.method === 'GET') return send(res, 200, { setup: !!auth, authed: isSignedIn(req, auth), ai: !!process.env.ANTHROPIC_API_KEY });
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
    const b = await readBody(req);
    if (!b) return send(res, 400, { error: 'Send JSON.' });
    const password = String(b.password || '');

    if (b.op === 'logout') return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, auth || { secret: 'x' }, true) });

    if (b.op === 'setup') {
      if (auth) return send(res, 409, { error: 'A password already exists. Sign in instead.' });
      if (password.length < 10) return send(res, 400, { error: 'Use at least 10 characters.' });
      const next = record(password);
      await writeJSON('auth.json', next);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, next) });
    }
    if (!auth) return send(res, 409, { error: 'Create a password first.' });

    if (b.op === 'login') {
      if (!sameText(hashPassword(password, auth.salt), auth.hash)) { await wait(600); return send(res, 401, { error: 'Wrong password.' }); }
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, auth) });
    }
    if (b.op === 'change') {
      if (!isSignedIn(req, auth)) return send(res, 401, { error: 'Sign in again.' });
      if (!sameText(hashPassword(String(b.current || ''), auth.salt), auth.hash)) { await wait(600); return send(res, 401, { error: 'The current password is wrong.' }); }
      if (password.length < 10) return send(res, 400, { error: 'Use at least 10 characters.' });
      const next = record(password);
      await writeJSON('auth.json', next);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, next) });
    }
    return send(res, 400, { error: 'Unknown request.' });
  } catch (e) { fail(res, e); }
}
