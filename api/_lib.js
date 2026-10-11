// Shared helpers: private Blob storage, sessions and small HTTP utilities.
// Files that start with an underscore are not exposed as routes.
import crypto from 'node:crypto';
import { put, get, list, del, BlobPreconditionFailedError } from '@vercel/blob';

const ROOT = 'db/';
const DAY = 86400;

export async function readDoc(path) {
  const r = await get(ROOT + path, { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200) return null;
  const text = await new Response(r.stream).text();
  return { text, etag: r.blob.etag };
}
export async function readJSON(path) {
  const d = await readDoc(path);
  return d ? { data: JSON.parse(d.text), etag: d.etag } : null;
}
export function writeDoc(path, body, contentType, etag) {
  const opts = { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType };
  if (etag) opts.ifMatch = etag;
  return put(ROOT + path, body, opts);
}
export const writeJSON = (path, data, etag) => writeDoc(path, JSON.stringify(data), 'application/json', etag);
export const removeDoc = (path) => del(ROOT + path);
export async function listDocs(prefix) {
  const out = [];
  let cursor;
  do {
    const r = await list({ prefix: ROOT + prefix, cursor, limit: 1000 });
    r.blobs.forEach((b) => out.push(b.pathname.slice(ROOT.length)));
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}
/** Read, change and write one JSON document, retrying if another device wrote first. */
export async function mutateJSON(path, change) {
  for (let i = 0; i < 4; i++) {
    const cur = await readJSON(path);
    if (!cur) return null;
    const next = change(cur.data);
    try {
      await writeJSON(path, next, cur.etag);
      return next;
    } catch (e) {
      if (!(e instanceof BlobPreconditionFailedError) || i === 3) throw e;
    }
  }
  return null;
}

// ---------- sessions ----------
const sign = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('base64url');
export const hashPassword = (password, salt) => crypto.scryptSync(String(password), salt, 32).toString('base64url');
export const randomId = (n) => crypto.randomBytes(n).toString('base64url');
export function sameText(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export async function getAuth() {
  const d = await readJSON('auth.json');
  return d ? d.data : null;
}
function cookieOf(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : '';
}
export function isSignedIn(req, auth) {
  if (!auth) return false;
  const [exp, mac] = cookieOf(req, 'le_session').split('.');
  return !!exp && !!mac && Number(exp) > Date.now() / 1000 && sameText(mac, sign(auth.secret, exp));
}
export function sessionCookie(req, auth, clear) {
  const local = /^(localhost|127\.)/.test(String(req.headers.host || ''));
  const exp = String(Math.floor(Date.now() / 1000) + 30 * DAY);
  const value = clear ? '' : exp + '.' + sign(auth.secret, exp);
  return 'le_session=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (clear ? 0 : 30 * DAY) + (local ? '' : '; Secure');
}
/** Returns the auth record when the request carries a valid session, otherwise answers 401. */
export async function requireUser(req, res) {
  const auth = await getAuth();
  if (isSignedIn(req, auth)) return auth;
  send(res, 401, { error: 'Sign in again.' });
  return null;
}

// ---------- http ----------
export function send(res, status, body, headers) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  Object.entries(headers || {}).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(body));
}
export async function readBody(req) {
  if (!/^application\/json/i.test(String(req.headers['content-type'] || ''))) return null;
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return null; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch (e) { return null; }
}
export function fail(res, e) {
  const msg = String((e && e.message) || e);
  const storage = /token|store|BLOB|OIDC/i.test(msg);
  send(res, storage ? 503 : 500, { error: storage ? 'Storage is not connected. In Vercel, open this project, go to Storage and connect a private Blob store, then redeploy.' : 'Something went wrong on the server.' });
  console.error(e);
}
