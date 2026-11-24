"""Reuse only the owner's ordinary authenticated Chronogolf session."""
import json
import os
import re
import time
from pathlib import Path
from urllib.parse import urlparse


class SessionRequired(Exception):
    pass


def normalize_cookies(raw):
    cookies = raw.get("cookies", []) if isinstance(raw, dict) else raw
    result = []
    for c in cookies if isinstance(cookies, list) else []:
        if not isinstance(c, dict):
            continue
        name, value, domain = c.get("name"), c.get("value"), c.get("domain")
        if not all(isinstance(x, str) and x for x in (name, value, domain)):
            continue
        if not re.search(r"(^|\.)chronogolf\.com$", domain, re.I) or re.match(r"^(cf_|__cf|_cfuvid)", name, re.I):
            continue
        try:
            expires = float(c.get("expirationDate") or c.get("expires") or -1)
        except (TypeError, ValueError):
            continue
        if 0 <= expires <= time.time():
            continue
        same_site = {"none": "None", "no_restriction": "None", "strict": "Strict", "lax": "Lax"}
        result.append({
            "name": name, "value": value, "domain": domain, "path": c.get("path") or "/",
            "expires": expires, "httpOnly": bool(c.get("httpOnly")), "secure": bool(c.get("secure", True)),
            "sameSite": same_site.get(str(c.get("sameSite")).lower(), "Lax"),
        })
    return result


async def open_dashboard(context):
    try:
        raw = json.loads(Path(os.environ["CHRONOGOLF_COOKIES_FILE"]).read_text())
        cookies = normalize_cookies(raw)
        if not cookies:
            raise ValueError("Empty session")
        await context.add_cookies(cookies)
    except (KeyError, OSError, ValueError):
        raise SessionRequired("No current Chronogolf session; sign in manually and upload a fresh session") from None
    page = await context.new_page()
    page.on("console", lambda m: print(f"[PAGE] {m.text}", flush=True) if m.text.startswith("[API]") else None)
    response = await page.goto("https://www.chronogolf.com/dashboard", wait_until="domcontentloaded", timeout=30000)
    await page.wait_for_timeout(3000)
    final = urlparse(page.url)
    challenge = await page.locator(
        "#challenge-form, #cf-challenge-running, iframe[src*='challenges.cloudflare.com'], input[autocomplete='one-time-code']"
    ).count()
    if (not response or not response.ok or response.headers.get("cf-mitigated") == "challenge" or challenge
            or final.hostname not in {"www.chronogolf.com", "chronogolf.com"}
            or not re.match(r"^/dashboard(?:/|$)", final.path)):
        why = (f"HTTP {response.status if response else 'none'}, final page {final.hostname}{final.path}, "
               f"cf-mitigated={response.headers.get('cf-mitigated') if response else None}, challenge elements={challenge}")
        print(f"[BLOCKED] Dashboard check: {why}", flush=True)
        raise SessionRequired(f"Chronogolf login or verification required ({why}); complete it manually before resuming")
    return page
