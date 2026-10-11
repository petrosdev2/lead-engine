// GET /p/<slug> (rewritten to /api/p?slug=…) -> the published preview page. Public.
import { readDoc } from './_lib.js';

const SLUG = /^[a-z0-9][a-z0-9-]{1,80}$/;

export default async function handler(req, res) {
  const page = (status, html) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    // Previews are plain pages: no scripts, no outside requests, nothing that can touch the app.
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    res.setHeader('Cache-Control', 'no-store');
    res.end(html);
  };
  try {
    const slug = String(new URL(req.url, 'http://x').searchParams.get('slug') || '');
    const doc = SLUG.test(slug) ? await readDoc('previews/' + slug + '.html') : null;
    if (!doc) return page(404, '<!doctype html><meta charset="utf-8"><title>Preview removed</title><p style="font:16px system-ui;margin:40px">This preview is no longer available.</p>');
    return page(200, doc.text);
  } catch (e) {
    console.error(e);
    return page(503, '<!doctype html><meta charset="utf-8"><title>Unavailable</title><p style="font:16px system-ui;margin:40px">This preview is unavailable right now.</p>');
  }
}
