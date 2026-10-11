// POST /api/audit { url, country } -> what a customer on a phone finds on that website.
// The same checks as tools/find-leads/scripts/audit_sites.py. It reads public pages and contacts nobody.
import dns from 'node:dns/promises';
import net from 'node:net';
import { getCountryCallingCode, isSupportedCountry } from 'libphonenumber-js/min';
import { requireUser, readBody, send, fail } from './_lib.js';

const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const SOCIAL_HOSTS = ['facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'wa.me', 'whatsapp.com', 'linktr.ee', 'tiktok.com', 'twitter.com', 'x.com',
  'youtube.com', 'linkedin.com', 'business.site', 'g.page', 'goo.gl', 'bit.ly', 'beacons.ai', 'taplink.cc'];
const WA_PATTERNS = [/wa\.me\/(?:\+|%2B)?(\d{8,15})/gi, /whatsapp(?:\.com|:\/)\/send\/?\?[^"'\s<>]*?phone=(?:\+|%2B)?(\d{8,15})/gi];
const BOOKING = /calendly\.com|acuityscheduling|squareup\.com\/appointments|booksy\.com|fresha\.com|setmore\.com|simplybook|housecallpro|getjobber|vagaro\.com|mindbodyonline|typeform\.com|jotform|forms\.gle|docs\.google\.com\/forms|hsforms|tally\.so|wpforms|wpcf7|gform_wrapper|elementor-form|ninja-forms|fluentform|frm_forms/i;
const JS_BUILDERS = /wixstatic\.com|parastorage\.com|wsimg\.com|framerusercontent|cdn-website\.com|multiscreensite/i;
const PARKED = /domain (?:is |may be )?for sale|buy this domain|sedoparking|hugedomains|parked free|this domain is parked/i;
const CHALLENGE = /cf-chl|attention required|verify you are human|captcha/i;
const CONTACT_LINK = /href=["']([^"'#]*(?:contact|kontakt|quote|book|enquir|inquir|anfrage|appointment|termin|estimate|get-in-touch)[^"'#]*)["']/i;
const YEAR = /(?:©|&copy;|&#169;|copyright)\s*(?:\(c\)\s*)?(?:(?:19|20)\d{2}\s*(?:-|–|&ndash;|to)\s*)?((?:19|20)\d{2})/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,10}/g;
const TIMEOUT = 12000, MAX_BYTES = 900000;
const allowLocal = () => process.env.LE_TEST_ALLOW_LOCAL === '1';

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const s = ip.toLowerCase();
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateAddress(mapped[1]);
  return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || /^::ffff:/.test(s) || /^64:ff9b:/.test(s);
}
/** Only public web addresses on the normal ports may be visited. */
async function publicUrl(str) {
  let u;
  try { u = new URL(str); } catch (e) { return null; }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
  if (allowLocal()) return u;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return privateAddress(host) ? null : u;
  if (!host.includes('.') || /\.(local|localhost|internal|lan|home|corp)$/i.test(host)) return null;
  const found = await dns.lookup(host, { all: true });
  return found.length && !found.some((a) => privateAddress(a.address)) ? u : null;
}
const problem = (kind, extra) => Object.assign(new Error(kind), { kind }, extra || {});

async function readPage(r) {
  const label = (String(r.headers.get('content-type') || '').match(/charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
  const chunks = [];
  let size = 0;
  if (r.body) {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.length;
      if (size >= MAX_BYTES) { try { await reader.cancel(); } catch (e) {} break; }
    }
  }
  const buf = Buffer.concat(chunks).subarray(0, MAX_BYTES);
  try { return new TextDecoder(label).decode(buf); } catch (e) { return new TextDecoder('utf-8').decode(buf); }
}
/** Loads one page, following up to five redirects and checking every hop. */
async function getPage(start) {
  let url = start;
  for (let hop = 0; hop < 6; hop++) {
    const u = await publicUrl(url);
    if (!u) throw problem('refused');
    const r = await fetch(u, { redirect: 'manual', headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8', 'accept-language': 'en' }, signal: AbortSignal.timeout(TIMEOUT) });
    const to = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && to) {
      try { if (r.body) await r.body.cancel(); } catch (e) {}
      try { url = new URL(to, u).href; } catch (e) { throw problem('refused'); }
      continue;
    }
    if (!r.ok) { try { if (r.body) await r.body.cancel(); } catch (e) {} throw problem('http', { status: r.status }); }
    return { final: u.href, html: await readPage(r) };
  }
  throw problem('loop');
}

const hostOf = (url) => { try { return new URL(/^[a-z]+:\/\//i.test(url) ? url : 'http://' + url).hostname.toLowerCase(); } catch (e) { return ''; } };
const isSocial = (url) => { const h = hostOf(url); return SOCIAL_HOSTS.some((d) => h === d || h.endsWith('.' + d)); };
/** First WhatsApp number the business itself published, as +countrycode digits, or ''. */
function waNumber(page, cc) {
  for (const pat of WA_PATTERNS) {
    for (const m of page.matchAll(pat)) {
      let d = m[1];
      if (d.startsWith('00')) d = d.slice(2);
      else if (d.startsWith('0')) { if (!cc) continue; d = cc + d.replace(/^0+/, ''); }
      return '+' + d;
    }
  }
  return '';
}
function hasForm(html) {
  for (const m of html.matchAll(/<form\b[\s\S]*?<\/form>/gi)) {
    const block = m[0];
    const searchy = /role=["']search|type=["']search|name=["'](?:s|q|search)["']/i.test(block);
    if (searchy && !/<textarea|type=["'](?:email|tel)["']/i.test(block)) continue;
    if (/<textarea|<select|type=["'](?:email|tel|text)["']/i.test(block)) return true;
  }
  return BOOKING.test(html);
}
const certTrouble = (e) => /CERT|SSL|TLS|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY/i.test(String((e && e.cause && (e.cause.code || e.cause.message)) || ''));

async function checkSite(site, cc) {
  const res = { site: '', https: '', mobile: '', form: '', wabtn: '', waNumber: '', emails: [], phones: [], note: '', url: site, finding: '' };
  site = String(site || '').trim();
  if (!site) { res.site = 'none'; return res; }
  if (isSocial(site)) { res.site = 'social'; res.waNumber = waNumber(site, cc); return res; }
  if (/^[a-z][a-z0-9+.-]*:/i.test(site) && !/^https?:\/\//i.test(site)) { res.site = 'blocked'; res.note = 'This address cannot be checked automatically. Check it by hand.'; return res; }
  const tries = /^https:\/\//i.test(site) ? [site, 'http://' + site.slice(8)] : /^http:\/\//i.test(site) ? [site] : ['https://' + site, 'http://' + site];
  let page = null, cert = false, note = '';
  for (const url of tries) {
    for (let attempt = 1; attempt <= 2 && !page; attempt++) {
      try { page = await getPage(url); }
      catch (e) {
        if (e.kind === 'http') {
          const blocked = [401, 403, 406, 429, 503, 999].includes(e.status);
          res.site = blocked ? 'blocked' : 'unreachable';
          res.note = blocked ? 'The site refused an automatic visit (HTTP ' + e.status + '). Check it by hand.' : 'The home page answered with error ' + e.status + '.';
          return res;
        }
        if (e.kind === 'refused') { res.site = 'blocked'; res.note = 'This address cannot be checked automatically. Check it by hand.'; return res; }
        if (certTrouble(e)) { cert = true; note = 'Security certificate problem.'; break; }
        if (e.kind === 'loop') { note = 'The address keeps redirecting.'; break; }
        if (e.name === 'TimeoutError' || e.name === 'AbortError') { note = 'Timed out after ' + TIMEOUT / 1000 + ' seconds.'; break; }
        note = 'Could not connect.';
        if (attempt === 1) await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (page) break;
  }
  if (!page) { res.site = 'unreachable'; res.note = note || 'Could not load.'; return res; }
  const html = page.html, final = page.final;
  if (PARKED.test(html.slice(0, 40000))) { res.site = 'unreachable'; res.note = 'The address shows a parked or for-sale page.'; return res; }
  if (html.length < 20000 && CHALLENGE.test(html)) { res.site = 'blocked'; res.note = 'The site showed a robot check. Check it by hand.'; return res; }

  res.site = 'ok'; res.url = final;
  res.https = /^https:\/\//i.test(final) && !cert ? 'yes' : 'no';
  if (cert) res.note = 'Security certificate problem on the https address.';
  res.mobile = /<meta[^>]+name=["']?viewport/i.test(html) ? 'yes' : 'no';

  let pages = html, form = hasForm(html);
  const link = html.match(CONTACT_LINK);
  if (link && !(form && waNumber(html, cc))) {
    try {
      const next = new URL(link[1].replace(/&amp;/g, '&'), final).href;
      if (hostOf(next) === hostOf(final) && next.replace(/\/$/, '') !== final.replace(/\/$/, '')) {
        const more = await getPage(next);
        pages += '\n' + more.html; form = form || hasForm(more.html);
      }
    } catch (e) {}
  }
  res.form = form ? 'yes' : JS_BUILDERS.test(html) ? 'unknown' : 'no';
  res.waNumber = waNumber(pages, cc);
  res.wabtn = res.waNumber || /wa\.me\/|whatsapp\.com\/send|chat\.whatsapp\.com/i.test(pages) ? 'yes' : /whatsapp/i.test(pages) ? 'unknown' : 'no';

  const found = [...pages.matchAll(/mailto:([^"'?\s<>]+)/gi)].map((m) => m[1]).concat(pages.match(EMAIL) || []);
  for (let e of found) {
    try { e = decodeURIComponent(e); } catch (x) {}
    e = e.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,10}$/.test(e) && !/\.(png|jpe?g|gif|webp|svg|css|js)$|example\.|sentry|wixpress|@\dx/.test(e) && !res.emails.includes(e)) res.emails.push(e);
    if (res.emails.length === 3) break;
  }
  for (const m of pages.matchAll(/href=["']tel:([^"']{7,25})["']/gi)) {
    let p = m[1];
    try { p = decodeURIComponent(p); } catch (x) {}
    p = p.replace(/[^\d+]/g, '');
    if (p.length >= 7 && !res.phones.includes(p)) res.phones.push(p);
    if (res.phones.length === 3) break;
  }
  const now = new Date().getFullYear();
  const years = [...pages.matchAll(YEAR)].map((m) => Number(m[1])).filter((y) => y <= now);
  if (years.length && Math.max(...years) <= now - 3) res.finding = 'The footer on their website still shows the year ' + Math.max(...years) + '.';
  return res;
}

export default async function handler(req, res) {
  try {
    if (!(await requireUser(req, res))) return;
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
    const b = await readBody(req);
    const url = String((b && b.url) || '').trim();
    if (!url || url.length > 500) return send(res, 400, { error: 'The website address is missing or too long.' });
    const c = String((b && b.country) || '').toUpperCase();
    const cc = /^[A-Z]{2}$/.test(c) && isSupportedCountry(c) ? String(getCountryCallingCode(c)) : '';
    return send(res, 200, await checkSite(url, cc));
  } catch (e) { fail(res, e); }
}
