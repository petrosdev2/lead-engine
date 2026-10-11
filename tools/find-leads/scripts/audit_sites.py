#!/usr/bin/env python3
"""Audit the websites of scraped Google Maps leads and write one CSV for Lead Engine.

Usage
  python3 audit_sites.py --out leads.csv [--cc 234] [--only-missing] raw.csv [more.csv ...]
  python3 audit_sites.py set leads.csv "Business name or place id" finding "One sentence."
  python3 audit_sites.py set leads.csv "Business name or place id" website "https://..."

Standard library only. It reads public web pages and never sends a message to anyone.
"""
import argparse
import csv
import json
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date

UA = ('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36')
SOCIAL_HOSTS = ('facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'wa.me', 'whatsapp.com', 'linktr.ee',
                'tiktok.com', 'twitter.com', 'x.com', 'youtube.com', 'linkedin.com', 'business.site',
                'g.page', 'goo.gl', 'bit.ly', 'beacons.ai', 'taplink.cc')
WA_PATTERNS = (re.compile(r'wa\.me/(?:\+|%2B)?(\d{8,15})', re.I),
               re.compile(r'whatsapp(?:\.com|:/)/send/?\?[^"\'\s<>]*?phone=(?:\+|%2B)?(\d{8,15})', re.I))
BOOKING = re.compile(r'calendly\.com|acuityscheduling|squareup\.com/appointments|booksy\.com|fresha\.com|setmore\.com'
                     r'|simplybook|housecallpro|getjobber|vagaro\.com|mindbodyonline|typeform\.com|jotform|forms\.gle'
                     r'|docs\.google\.com/forms|hsforms|tally\.so|wpforms|wpcf7|gform_wrapper|elementor-form'
                     r'|ninja-forms|fluentform|frm_forms', re.I)
JS_BUILDERS = re.compile(r'wixstatic\.com|parastorage\.com|wsimg\.com|framerusercontent|cdn-website\.com|multiscreensite', re.I)
PARKED = re.compile(r'domain (?:is |may be )?for sale|buy this domain|sedoparking|hugedomains|parked free|this domain is parked', re.I)
CHALLENGE = re.compile(r'cf-chl|attention required|verify you are human|captcha', re.I)
CONTACT_LINK = re.compile(r'href=["\']([^"\'#]*(?:contact|quote|book|enquir|inquir|appointment|estimate|get-in-touch)[^"\'#]*)["\']', re.I)
YEAR = re.compile(r'(?:©|&copy;|&#169;|copyright)\s*(?:\(c\)\s*)?(?:(?:19|20)\d{2}\s*(?:-|–|&ndash;|to)\s*)?((?:19|20)\d{2})', re.I)
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,10}')
NEW_COLS = ['whatsapp_number', 'audit_checked', 'audit_site', 'audit_https', 'audit_mobile', 'audit_form',
            'audit_whatsapp_button', 'audit_slow', 'pagespeed_mobile', 'site_emails', 'site_phones',
            'audit_note', 'audit_url', 'finding']
WEBSITE_KEYS = ('website', 'site', 'url', 'websiteurl', 'web', 'domain')
NAME_KEYS = ('title', 'name', 'businessname', 'company', 'companyname', 'placename')
ID_KEYS = ('placeid', 'cid', 'dataid', 'googleplaceid')
PHONE_KEYS = ('phone', 'phonenumber', 'telephone')


def norm(h):
    return re.sub(r'[^a-z0-9]', '', str(h).lower())


def find_col(fields, keys):
    by = {norm(f): f for f in fields}
    for k in keys:
        if k in by:
            return by[k]
    return None


def host_of(url):
    u = url if re.match(r'^[a-z]+://', url, re.I) else 'http://' + url
    try:
        return (urllib.parse.urlsplit(u).hostname or '').lower()
    except ValueError:
        return ''


def is_social(url):
    h = host_of(url)
    return any(h == d or h.endswith('.' + d) for d in SOCIAL_HOSTS)


def wa_number(text, cc):
    """First WhatsApp number in the text, as +countrycode digits, or ''."""
    for pat in WA_PATTERNS:
        m = pat.search(text)
        if m:
            d = m.group(1)
            if d.startswith('00'):
                d = d[2:]
            elif d.startswith('0'):
                if not cc:
                    continue
                d = cc + d.lstrip('0')
            return '+' + d
    return ''


def fetch(url, timeout):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'en'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read(900000)
        charset = r.headers.get_content_charset() or 'utf-8'
        try:
            html = raw.decode(charset, 'replace')
        except LookupError:
            html = raw.decode('utf-8', 'replace')
        return r.geturl(), html


def has_form(html):
    for m in re.finditer(r'<form\b.*?</form>', html, re.I | re.S):
        block = m.group(0)
        searchy = re.search(r'role=["\']search|type=["\']search|name=["\'](?:s|q|search)["\']', block, re.I)
        if searchy and not re.search(r'<textarea|type=["\'](?:email|tel)["\']', block, re.I):
            continue
        if re.search(r'<textarea|<select|type=["\'](?:email|tel|text)["\']', block, re.I):
            return True
    return bool(BOOKING.search(html))


def check_site(site, cc, timeout, psi_key=''):
    res = {'audit_site': '', 'audit_https': '', 'audit_mobile': '', 'audit_form': '', 'audit_whatsapp_button': '',
           'audit_slow': '', 'pagespeed_mobile': '', 'whatsapp_number': '', 'site_emails': '', 'site_phones': '',
           'audit_note': '', 'audit_url': site, 'auto_finding': ''}
    site = site.strip()
    if not site:
        res['audit_site'] = 'none'
        return res
    if is_social(site):
        res['audit_site'] = 'social'
        res['whatsapp_number'] = wa_number(site, cc)
        return res
    if re.match(r'^https://', site, re.I):
        tries = [site, 'http://' + site[8:]]
    elif re.match(r'^http://', site, re.I):
        tries = [site]
    else:
        tries = ['https://' + site, 'http://' + site]
    final = html = None
    cert_problem = False
    note = ''
    for i, url in enumerate(tries):
        for attempt in (1, 2):
            try:
                final, html = fetch(url, timeout)
                break
            except urllib.error.HTTPError as e:
                if e.code in (401, 403, 406, 429, 503, 999):
                    res['audit_site'] = 'blocked'
                    res['audit_note'] = 'The site refused an automatic visit (HTTP %d). Check it by hand.' % e.code
                else:
                    res['audit_site'] = 'unreachable'
                    res['audit_note'] = 'The home page answered with error %d.' % e.code
                return res
            except urllib.error.URLError as e:
                reason = getattr(e, 'reason', e)
                if isinstance(reason, ssl.SSLError):
                    cert_problem = True
                    note = 'Security certificate problem.'
                    break
                note = 'Could not connect (%s).' % str(reason)[:80]
            except ssl.SSLError:
                cert_problem = True
                note = 'Security certificate problem.'
                break
            except (socket.timeout, TimeoutError):
                note = 'Timed out after %d seconds.' % timeout
            except (OSError, ValueError) as e:
                note = 'Could not load (%s).' % str(e)[:80]
            if attempt == 1:
                time.sleep(1.5)
        if html is not None:
            break
    if html is None:
        res['audit_site'] = 'unreachable'
        res['audit_note'] = note or 'Could not load.'
        return res
    if PARKED.search(html[:40000]):
        res['audit_site'] = 'unreachable'
        res['audit_note'] = 'The address shows a parked or for-sale page.'
        return res
    if len(html) < 20000 and CHALLENGE.search(html):
        res['audit_site'] = 'blocked'
        res['audit_note'] = 'The site showed a robot check. Check it by hand.'
        return res

    res['audit_site'] = 'ok'
    res['audit_https'] = 'yes' if final.lower().startswith('https://') and not cert_problem else 'no'
    if cert_problem:
        res['audit_note'] = 'Security certificate problem on the https address.'
    res['audit_mobile'] = 'yes' if re.search(r'<meta[^>]+name=["\']?viewport', html, re.I) else 'no'

    pages = html
    form = has_form(html)
    m = CONTACT_LINK.search(html)
    if m and not (form and wa_number(html, cc)):
        link = urllib.parse.urljoin(final, m.group(1).replace('&amp;', '&'))
        if host_of(link) == host_of(final) and link.rstrip('/') != final.rstrip('/'):
            try:
                _, more = fetch(link, timeout)
                pages += '\n' + more
                form = form or has_form(more)
            except Exception:
                pass
    res['audit_form'] = 'yes' if form else ('unknown' if JS_BUILDERS.search(html) else 'no')

    number = wa_number(pages, cc)
    res['whatsapp_number'] = number
    res['audit_whatsapp_button'] = 'yes' if number or re.search(r'wa\.me/|whatsapp\.com/send|chat\.whatsapp\.com', pages, re.I) \
        else ('unknown' if re.search(r'whatsapp', pages, re.I) else 'no')

    emails = []
    for e in re.findall(r'mailto:([^"\'?\s<>]+)', pages, re.I) + EMAIL.findall(pages):
        e = urllib.parse.unquote(e).strip().lower().strip('.')
        if EMAIL.fullmatch(e) and not re.search(r'\.(png|jpe?g|gif|webp|svg|css|js)$|example\.|sentry|wixpress|@\dx', e) and e not in emails:
            emails.append(e)
    res['site_emails'] = '; '.join(emails[:3])
    phones = []
    for p in re.findall(r'href=["\']tel:([^"\']{7,25})["\']', pages, re.I):
        p = re.sub(r'[^\d+]', '', urllib.parse.unquote(p))
        if len(p) >= 7 and p not in phones:
            phones.append(p)
    res['site_phones'] = '; '.join(phones[:3])

    years = [int(y) for y in YEAR.findall(pages) if int(y) <= date.today().year]
    if years and max(years) <= date.today().year - 3:
        res['auto_finding'] = 'The footer on their website still shows the year %d.' % max(years)

    if psi_key:
        try:
            q = urllib.parse.urlencode({'url': final, 'strategy': 'mobile', 'category': 'performance', 'key': psi_key})
            with urllib.request.urlopen('https://www.googleapis.com/pagespeedonline/v5/runPagespeed?' + q, timeout=90) as r:
                score = json.load(r)['lighthouseResult']['categories']['performance']['score']
            if score is not None:
                res['pagespeed_mobile'] = str(round(score * 100))
                res['audit_slow'] = 'yes' if score < 0.5 else 'no'
        except Exception as e:
            res['audit_note'] = (res['audit_note'] + ' PageSpeed check failed: %s' % str(e)[:60]).strip()
    return res


def read_rows(paths):
    rows, fields, seen, dups = [], [], set(), 0
    for path in paths:
        with open(path, newline='', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for name in reader.fieldnames or []:
                if name not in fields:
                    fields.append(name)
            ic, nc, pc = find_col(reader.fieldnames or [], ID_KEYS), find_col(reader.fieldnames or [], NAME_KEYS), find_col(reader.fieldnames or [], PHONE_KEYS)
            for row in reader:
                name = (row.get(nc) or '').strip() if nc else ''
                if not name:
                    continue
                key = (row.get(ic) or '').strip() if ic else ''
                key = key or norm(name) + '|' + re.sub(r'\D', '', row.get(pc) or '' if pc else '')
                if key in seen:
                    dups += 1
                    continue
                seen.add(key)
                rows.append(row)
    return rows, fields, dups


def write_rows(path, rows, fields):
    tmp = path + '.tmp'
    with open(tmp, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        w.writeheader()
        for row in rows:
            w.writerow({k: ('' if row.get(k) is None else row.get(k)) for k in fields})
    os.replace(tmp, path)


def cmd_set(argv):
    if len(argv) != 4:
        sys.exit('Usage: audit_sites.py set FILE "Business name or place id" FIELD "value"')
    path, who, field, value = argv
    rows, fields, _ = read_rows([path])
    if field not in fields:
        fields.append(field)
    nc, ic = find_col(fields, NAME_KEYS), find_col(fields, ID_KEYS)
    hits = [r for r in rows if (nc and (r.get(nc) or '').strip().lower() == who.strip().lower()) or (ic and (r.get(ic) or '').strip() == who.strip())]
    if len(hits) != 1:
        sys.exit('Expected exactly one row for "%s" but found %d. Use the exact name or the place id.' % (who, len(hits)))
    hits[0][field] = value
    write_rows(path, rows, fields)
    print('Set %s for %s.' % (field, hits[0].get(nc) if nc else who))


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'set':
        return cmd_set(sys.argv[2:])
    ap = argparse.ArgumentParser(description='Audit lead websites for Lead Engine.')
    ap.add_argument('inputs', nargs='+', help='One or more CSV files from the Google Maps scraper')
    ap.add_argument('--out', required=True, help='CSV file to write')
    ap.add_argument('--cc', default='', help='Country calling code without +, for example 234')
    ap.add_argument('--only-missing', action='store_true', help='Skip rows already audited for the same website')
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--timeout', type=int, default=20)
    ap.add_argument('--psi-key', default=os.environ.get('PSI_KEY', ''), help='Google PageSpeed API key, to test mobile speed')
    a = ap.parse_args()
    cc = re.sub(r'\D', '', a.cc)

    rows, fields, dups = read_rows(a.inputs)
    if not rows:
        sys.exit('No rows with a business name were found in: ' + ', '.join(a.inputs))
    wc = find_col(fields, WEBSITE_KEYS)
    for c in NEW_COLS:
        if c not in fields:
            fields.append(c)

    def work(row):
        site = (row.get(wc) or '').strip() if wc else ''
        if a.only_missing and (row.get('audit_checked') or '') == 'yes' and (row.get('audit_url') or '') == site:
            return
        res = check_site(site, cc, a.timeout, a.psi_key)
        auto = res.pop('auto_finding')
        found = res.pop('whatsapp_number')
        row.update(res)
        row['audit_checked'] = 'yes'
        if found or not (row.get('whatsapp_number') or '').strip():
            row['whatsapp_number'] = found
        if auto and not (row.get('finding') or '').strip():
            row['finding'] = auto

    with ThreadPoolExecutor(max_workers=max(1, a.workers)) as pool:
        done = 0
        for _ in pool.map(work, rows):
            done += 1
            if done % 10 == 0 or done == len(rows):
                print('Checked %d of %d' % (done, len(rows)), flush=True)
    write_rows(a.out, rows, fields)

    def n(col, val):
        return sum(1 for r in rows if (r.get(col) or '') == val)
    ok = [r for r in rows if r.get('audit_site') == 'ok']
    print('\nLeads: %d%s' % (len(rows), ' (%d duplicate%s removed)' % (dups, '' if dups == 1 else 's') if dups else ''))
    print('Websites: %d working, %d did not load, %d blocked the check, %d social page only, %d none listed'
          % (len(ok), n('audit_site', 'unreachable'), n('audit_site', 'blocked'), n('audit_site', 'social'), n('audit_site', 'none')))
    print('On the working websites: %d not secure, %d not built for phones, %d with no form or booking link, %d with no WhatsApp button'
          % (sum(1 for r in ok if r['audit_https'] == 'no'), sum(1 for r in ok if r['audit_mobile'] == 'no'),
             sum(1 for r in ok if r['audit_form'] == 'no'), sum(1 for r in ok if r['audit_whatsapp_button'] == 'no')))
    print('WhatsApp numbers found: %d' % sum(1 for r in rows if (r.get('whatsapp_number') or '').strip()))
    print('Saved: %s' % os.path.abspath(a.out))


if __name__ == '__main__':
    main()
