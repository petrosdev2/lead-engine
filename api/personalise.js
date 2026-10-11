// POST /api/personalise { prompt } -> { out }   Rewrites messages with the Anthropic API.
import { requireUser, readBody, send, fail } from './_lib.js';

function parseJSON(text) {
  const t = String(text || '').trim();
  const tries = [t, (t.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1], t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)];
  for (const s of tries) { if (!s) continue; try { return JSON.parse(s); } catch (e) {} }
  return null;
}

export default async function handler(req, res) {
  try {
    if (!(await requireUser(req, res))) return;
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return send(res, 503, { error: 'No Anthropic API key is set for this project.' });
    const b = await readBody(req);
    const prompt = String((b && b.prompt) || '');
    if (!prompt || prompt.length > 12000) return send(res, 400, { error: 'The request is empty or too long.' });

    const r = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] })
    });
    if (r.status === 429) return send(res, 429, { error: 'Too many requests. Wait a minute and try again.' });
    if (r.status === 401 || r.status === 403) return send(res, 502, { error: 'Anthropic rejected the API key. Check it in Vercel.' });
    if (!r.ok) {
      let why = ''; try { why = ((await r.json()).error || {}).message || ''; } catch (e) {}
      return send(res, 502, { error: /credit|billing/i.test(why) ? 'Your Anthropic account has no credit left.' : 'Claude could not answer just now.' });
    }
    const j = await r.json();
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    const out = parseJSON(text);
    return out ? send(res, 200, { out }) : send(res, 502, { error: 'Claude answered in a form the app could not read.' });
  } catch (e) { fail(res, e); }
}
