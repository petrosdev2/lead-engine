// GET  /api/search                                   -> { ready, left, perMonth }   is a search key saved, and what is left
// POST /api/search { op:'key', key }                 -> saves or removes the SerpApi key (it stays on the server)
// POST /api/search { op:'find', q, country, start, ll } -> { places, ll, more }     one page of Google Maps results
import { parsePhoneNumberFromString, isSupportedCountry } from 'libphonenumber-js/max';
import { requireUser, readBody, readJSON, writeJSON, send, fail } from './_lib.js';

const base = () => process.env.SERPAPI_BASE_URL || 'https://serpapi.com';
const LL = /^@-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?,\d{1,2}(\.\d+)?z$/;
const text = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

async function savedKey() {
  if (process.env.SERPAPI_KEY) return process.env.SERPAPI_KEY.trim();
  const s = await readJSON('secrets.json');
  return String((s && s.data && s.data.serpapi) || '');
}
async function getJSON(url, ms) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, ok: r.ok, j: j && typeof j === 'object' ? j : {} };
}
/** Reading the account is free and does not use up a search. */
async function account(key) {
  const r = await getJSON(base() + '/account.json?api_key=' + encodeURIComponent(key), 15000);
  if (!r.ok || r.j.error) return { ok: false, status: r.status };
  const n = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  return { ok: true, left: n(r.j.total_searches_left), perMonth: n(r.j.searches_per_month) };
}

function phone(raw, country) {
  raw = text(raw, 40);
  if (!raw) return { number: '', kind: '' };
  let pn = null;
  try { pn = parsePhoneNumberFromString(raw, country || undefined); } catch (e) {}
  if (!pn || !pn.isPossible()) return { number: raw, kind: '' };
  const t = pn.getType();
  const kind = t === 'MOBILE' ? 'mobile' : /^(FIXED_LINE|TOLL_FREE|PREMIUM_RATE|SHARED_COST|UAN)$/.test(t || '') ? 'landline' : '';
  return { number: pn.number, kind };
}
function website(raw) {
  let s = text(raw, 500);
  if (!s) return '';
  try {
    const u = new URL(s, 'https://www.google.com');
    if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === '/url' && u.searchParams.get('q')) s = u.searchParams.get('q');
    else s = u.href;
    return /^https?:\/\//i.test(s) ? s : '';
  } catch (e) { return ''; }
}
function place(p, country) {
  const type = Array.isArray(p.type) ? p.type[0] : p.type;
  const ph = phone(p.phone, country), g = p.gps_coordinates || {};
  const rating = Number(p.rating), reviews = Math.floor(Number(p.reviews));
  return {
    name: text(p.title, 200), category: text(type || (Array.isArray(p.types) ? p.types[0] : ''), 120),
    phone: ph.number, phoneKind: ph.kind, address: text(p.address, 300), website: website(p.website),
    rating: rating > 0 && rating <= 5 ? rating : '', reviews: reviews > 0 ? reviews : 0,
    placeId: text(p.place_id || p.data_cid || p.data_id, 200),
    lat: Number.isFinite(Number(g.latitude)) ? Number(g.latitude) : null, lng: Number.isFinite(Number(g.longitude)) ? Number(g.longitude) : null
  };
}
/** Where the map was looking, so the next page searches the same area. */
function mapPosition(j, places) {
  const next = j.serpapi_pagination && j.serpapi_pagination.next;
  if (next) { try { const v = new URL(next).searchParams.get('ll'); if (v && LL.test(v)) return v; } catch (e) {} }
  const sp = j.search_parameters && j.search_parameters.ll;
  if (sp && LL.test(sp)) return sp;
  const pts = places.filter((p) => p.lat !== null && p.lng !== null);
  if (!pts.length) return '';
  const mid = (k) => { const a = pts.map((p) => p[k]).sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  return '@' + mid('lat').toFixed(6) + ',' + mid('lng').toFixed(6) + ',12z';
}

export default async function handler(req, res) {
  try {
    if (!(await requireUser(req, res))) return;
    const key = await savedKey();

    if (req.method === 'GET') {
      if (!key) return send(res, 200, { ready: false });
      const a = await account(key).catch(() => ({ ok: false, status: 0 }));
      if (!a.ok) return send(res, 200, a.status === 401 ? { ready: false, rejected: true } : { ready: true, left: null, perMonth: null });
      return send(res, 200, { ready: true, left: a.left, perMonth: a.perMonth });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
    const b = await readBody(req);
    if (!b) return send(res, 400, { error: 'Send JSON.' });

    if (b.op === 'key') {
      const k = String(b.key || '').trim();
      const cur = await readJSON('secrets.json');
      const data = Object.assign({}, cur ? cur.data : {});
      if (!k) {
        delete data.serpapi;
        await writeJSON('secrets.json', data);
        return send(res, 200, { ready: !!process.env.SERPAPI_KEY });
      }
      if (!/^[A-Za-z0-9_-]{20,128}$/.test(k)) return send(res, 400, { error: 'That does not look like a SerpApi key. Copy "Your Private API Key" from the SerpApi dashboard.' });
      let a;
      try { a = await account(k); } catch (e) { return send(res, 502, { error: 'SerpApi did not answer. Try again in a minute.' }); }
      if (!a.ok) return send(res, a.status === 401 ? 400 : 502, { error: a.status === 401 ? 'SerpApi did not accept that key. Copy it again from the SerpApi dashboard.' : 'SerpApi did not answer. Try again in a minute.' });
      data.serpapi = k;
      await writeJSON('secrets.json', data);
      return send(res, 200, { ready: true, left: a.left, perMonth: a.perMonth });
    }

    if (b.op === 'find') {
      if (!key) return send(res, 409, { error: 'Save a SerpApi key first.' });
      const q = text(b.q, 200);
      if (q.length < 3) return send(res, 400, { error: 'Type the kind of business and the place.' });
      const c = String(b.country || '').toUpperCase();
      const country = /^[A-Z]{2}$/.test(c) && isSupportedCountry(c) ? c : '';
      let start = Math.max(0, Math.min(100, Math.floor(Number(b.start) || 0)));
      start -= start % 20;
      const ll = LL.test(String(b.ll || '')) ? String(b.ll) : '';
      if (start > 0 && !ll) return send(res, 400, { error: 'The next page needs the map position from the first page.' });

      const p = new URLSearchParams({ engine: 'google_maps', type: 'search', q, hl: 'en', api_key: key });
      if (ll) p.set('ll', ll);
      if (start) p.set('start', String(start));
      let r;
      try { r = await getJSON(base() + '/search.json?' + p, 50000); }
      catch (e) { return send(res, 504, { error: 'The search took too long. Try again.' }); }
      const err = typeof r.j.error === 'string' ? r.j.error : '';
      const empty = /hasn't returned any results|no results/i.test(err);
      if (r.status === 401) return send(res, 502, { error: 'SerpApi did not accept the saved key. Save a new one.' });
      if (r.status === 429) return send(res, 429, { error: /run out|searches/i.test(err) ? 'You have used all your searches for this month.' : 'Too many searches at once. Wait a minute and try again.' });
      if ((!r.ok || err) && !empty) return send(res, 502, { error: 'The search service answered with an error' + (err ? ': ' + text(err, 200) : ' (' + r.status + ').') });

      const raw = Array.isArray(r.j.local_results) ? r.j.local_results : (r.j.place_results && r.j.place_results.title ? [r.j.place_results] : []);
      const places = raw.filter((x) => x && typeof x === 'object').map((x) => place(x, country)).filter((x) => x.name);
      const pos = ll || mapPosition(r.j, places);
      const more = places.length > 0 && !!pos && (!!(r.j.serpapi_pagination && r.j.serpapi_pagination.next) || raw.length >= 20);
      return send(res, 200, { places, ll: pos, more });
    }
    return send(res, 400, { error: 'Unknown request.' });
  } catch (e) { fail(res, e); }
}
