---
name: find-leads
description: Find local business leads on Google Maps, check each website for problems, pick out WhatsApp numbers, and save one CSV ready to import into Lead Engine. Use when the user asks to find, scrape, audit or enrich leads.
argument-hint: "[kind of business] in [city, country]  or  [a CSV file to audit]"
allowed-tools: Bash(python3 ${CLAUDE_SKILL_DIR}/scripts/audit_sites.py *) Bash(docker *) Bash(mkdir *) WebSearch WebFetch Read
---

# Find leads

The user's request: $ARGUMENTS

You are preparing a lead file for the user's Lead Engine web app. The app scores each
business, shows what is wrong with its online presence, and writes the WhatsApp message.
Your job ends when one clean CSV is saved. You never contact a business.

Work inside `~/leads`. Put each run in its own folder: `~/leads/runs/<kind>-<city>` in
lowercase with dashes, for example `~/leads/runs/beauty-salons-lekki`. Create it with
`mkdir -p` before anything else.

## 1. Work out the job

- The request names a `.csv` file that exists: skip to step 3 and audit that file.
- The request is a search such as "beauty salons in Lekki, Lagos": do steps 2 to 6.
- The kind of business or the city is missing: ask for it in one short question.

Pick the country calling code from the place: Nigeria 234, Ghana 233, Kenya 254,
South Africa 27, United Kingdom 44, United Arab Emirates 971, India 91, United States
and Canada 1. For another country use its code. If you cannot tell the country, ask.

## 2. Scrape Google Maps

1. Run `docker info`. If it fails, tell the user to open Docker Desktop and wait until it
   says the engine is running, then stop.
2. Write `queries.txt` in the run folder, one search per line. Start with the plain
   request, then add 3 to 5 lines that name real neighbourhoods or districts of that
   city, for example `beauty salon in Ikoyi, Lagos, Nigeria`. Always include the country.
3. Run the scraper. The first run downloads a large image, so allow up to 15 minutes and
   run it in the background if your tools allow it:

   ```
   docker run --rm -v gmaps-playwright-cache:/opt \
     -v "$PWD/queries.txt:/queries.txt:ro" -v "$PWD:/out" \
     gosom/google-maps-scraper -input /queries.txt -results /out/raw.csv \
     -depth 1 -lang en -exit-on-inactivity 3m
   ```

   Run it from inside the run folder so `$PWD` is that folder.
4. Aim for about 60 businesses unless the user gave a number. If `raw.csv` has far
   fewer, write new neighbourhood searches to `queries2.txt` and run again with
   `-results /out/raw2.csv`. Stay under 150 businesses in one run and do not use
   `-email`, proxies or `-extra-reviews` unless the user asks.
5. If the scraper returns nothing twice, stop and tell the user what the output said.
   Do not invent businesses.

## 3. Audit the websites

Run the bundled script on every raw file from this run:

```
python3 ${CLAUDE_SKILL_DIR}/scripts/audit_sites.py --cc <code> --out leads.csv raw.csv [raw2.csv]
```

It removes duplicates, opens each website once, and adds these columns: `audit_site`
(ok, none, social, blocked or unreachable), `audit_https`, `audit_mobile`, `audit_form`,
`audit_whatsapp_button`, `whatsapp_number`, `site_emails`, `site_phones`, `audit_note`
and `finding`. A value of `unknown` means the script could not tell, and Lead Engine
treats it as no problem. If the user has a Google PageSpeed API key, add
`--psi-key <key>` to fill `audit_slow`.

## 4. Confirm the "no website" leads

A blank website in Google Maps does not prove the business has none. For up to 15 rows
where `audit_site` is `none` and the review count is between 20 and 200, search the web
for the business name plus its city. If you find a site that is clearly theirs (same
name, same city or phone), record it and audit again:

```
python3 ${CLAUDE_SKILL_DIR}/scripts/audit_sites.py set leads.csv "<exact business name>" website "https://..."
python3 ${CLAUDE_SKILL_DIR}/scripts/audit_sites.py --cc <code> --only-missing --out leads.csv leads.csv
```

Facebook, Instagram and directory pages are not websites. Leave those rows as they are.

## 5. Write one finding for the best leads

For up to 10 rows where `audit_site` is `ok` and the review count is between 20 and
200, open the home page with WebFetch and look for one thing a customer on a phone
would notice: a broken button, prices or dates that are years old, no opening hours, no
way to ask for a quote, photos that do not load. Write one plain sentence, under 20
words, stating only what you saw:

```
python3 ${CLAUDE_SKILL_DIR}/scripts/audit_sites.py set leads.csv "<exact business name>" finding "The booking button on the home page opens an error page."
```

If nothing concrete stands out, leave `finding` empty. Never guess, never judge taste,
and never write a finding about a page you could not open.

## 6. Hand over

1. Run `explorer.exe "$(wslpath -w .)"` from the run folder so the folder opens in
   Windows. Ignore its exit code. Skip this step if `wslpath` is missing.
2. Tell the user, in a few lines: how many businesses were saved, how many have a
   WhatsApp number, how many have each problem (use the script's summary), and the full
   path to `leads.csv`.
3. Tell them the next step: in Lead Engine, open Import, choose `leads.csv`, type the
   kind of business in the box, and import.

## Rules

- Blank stays blank. A field the scraper or the audit did not capture is unknown, not
  missing.
- A `whatsapp_number` comes only from a WhatsApp link the business itself published.
  Never copy the listing phone number into that column.
- Keep everything in the run folder. Do not edit or delete files from earlier runs.
