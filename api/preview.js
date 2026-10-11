// POST   /api/preview { slug, html } -> { path }   Publish a preview page at /p/<slug>.
// DELETE /api/preview?slug=…          -> { ok }     Take it down.
import { requireUser, readBody, writeDoc, removeDoc, send, fail } from './_lib.js';

const SLUG = /^[a-z0-9][a-z0-9-]{1,80}$/;

export default async function handler(req, res) {
  try {
    if (!(await requireUser(req, res))) return;
    if (req.method === 'DELETE') {
      const slug = String(new URL(req.url, 'http://x').searchParams.get('slug') || '');
      if (!SLUG.test(slug)) return send(res, 400, { error: 'Bad preview name.' });
      await removeDoc('previews/' + slug + '.html');
      return send(res, 200, { ok: true });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
    const b = await readBody(req);
    const slug = String((b && b.slug) || ''), html = String((b && b.html) || '');
    if (!SLUG.test(slug)) return send(res, 400, { error: 'Bad preview name.' });
    if (!html || html.length > 400000) return send(res, 400, { error: 'The preview is empty or too large.' });
    await writeDoc('previews/' + slug + '.html', html, 'text/html; charset=utf-8');
    return send(res, 200, { path: '/p/' + slug });
  } catch (e) { fail(res, e); }
}
