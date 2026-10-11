# Lead Engine

A small web app for Petronix Technology. It takes a list of local businesses, shows what is
wrong with each one's online presence, picks the service that fixes it, writes the WhatsApp
message, and tracks the follow-ups.

## What is in this repo

| Path | What it is |
| --- | --- |
| `public/index.html` | The whole app: one page, no build step |
| `api/auth.js` | Create password, sign in, sign out, change password |
| `api/data.js` | Read and save leads and settings |
| `api/personalise.js` | Rewrites messages with the Anthropic API (optional) |
| `api/preview.js`, `api/p.js` | Publish a preview site and serve it at `/p/<name>` |
| `api/_lib.js` | Storage, session and HTTP helpers shared by the routes |
| `tools/` | The `/find-leads` command for Claude Code and its installer |

## Hosting on Vercel

1. Import this repo as a new Vercel project. No framework, no build command.
2. In the project, open **Storage**, create a **Blob** store with **private** access and
   connect it to the project. Leads are kept there as JSON files under `db/`.
3. Optional: add the environment variable `ANTHROPIC_API_KEY` to switch on
   "Personalise with Claude". `ANTHROPIC_MODEL` changes the model
   (default `claude-haiku-4-5-20251001`).
4. Redeploy, open the site and create your password. The first visitor sets it, so do
   this straight away.

## Good to know

- **Forgot the password?** In Vercel, open the Blob store and delete `db/auth.json`. The
  next visit asks for a new password. Leads are not touched.
- **Backups.** Everything is under `db/` in the Blob store: `leadsets/` holds the leads,
  `config/main.json` the settings, `previews/` the published preview pages.
- **Previews are public** to anyone with the link, carry a "not a live website" label,
  and are served with no scripts and a noindex header.
- The page is marked noindex and every data route needs a signed-in session.

## Finding leads

Run `python3 tools/install_lead_tools.py` inside Ubuntu (WSL) once. Then, in Claude Code:

```
/find-leads beauty salons in Lekki, Lagos, Nigeria
```

It saves `leads.csv`, which you upload on the app's Import page.
