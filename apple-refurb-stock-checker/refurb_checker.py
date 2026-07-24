#!/usr/bin/env python3
"""
Apple Refurbished Store stock checker.

Watches an Apple Certified Refurbished category page (default: US Mac mini) for
products matching your criteria — e.g. "Mac mini, M4 Pro, 64GB RAM" — and
notifies you by email, SMS, and/or a macOS desktop notification the moment a
matching item appears in stock.

Design goals:
  * Pure Python standard library — no `pip install`, nothing to break on macOS.
  * Robust matching: the refurb *grid* often does not print the RAM in a tile's
    title, so we confirm fine-grained specs (like "64GB") against each candidate
    product's detail page, where the full configuration is always listed.
  * Restock-aware de-duplication: alerts only on newly in-stock matches, and
    re-alerts if an item sells out and later comes back.

Run once (intended for launchd/cron), loop internally, calibrate, or test:

    python3 refurb_checker.py                 # one check, notify on new matches
    python3 refurb_checker.py --list          # print every tile + match status
    python3 refurb_checker.py --loop 900      # self-scheduling, every 15 min
    python3 refurb_checker.py --test-notify   # send a test to every channel
    python3 refurb_checker.py --from-file p.html --list   # offline parser test

Configuration lives in config.json next to this script (see config.example.json).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import smtplib
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from html.parser import HTMLParser

BASE_URL = "https://www.apple.com"

# A real desktop-Safari User-Agent. Apple serves generic scraper agents a 403,
# so identifying as a browser is what makes the fetch succeed on your iMac.
DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

def resolve_secret(value):
    """Allow secrets to be pulled from the environment.

    A config value of the form "env:VAR_NAME" is replaced with os.environ["VAR_NAME"],
    so passwords/tokens can stay out of the config file.
    """
    if isinstance(value, str) and value.startswith("env:"):
        return os.environ.get(value[4:], "")
    return value


def load_config(path):
    if not os.path.exists(path):
        sys.exit(
            f"Config not found: {path}\n"
            f"Copy config.example.json to config.json and edit it."
        )
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


# --------------------------------------------------------------------------- #
# Networking
# --------------------------------------------------------------------------- #

def fetch(url, timeout=30, retries=3):
    """GET a URL as a browser would. Returns decoded text, or raises on failure.

    Retries with exponential backoff on transient network errors. A 404 is
    treated as fatal (no point retrying a missing page).
    """
    headers = {
        "User-Agent": DEFAULT_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        # Ask for an uncompressed body so we don't have to gunzip by hand.
        "Accept-Encoding": "identity",
        "Connection": "close",
    }
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                charset = resp.headers.get_content_charset() or "utf-8"
                return raw.decode(charset, errors="replace")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise
            last_err = exc
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            last_err = exc
        if attempt < retries - 1:
            time.sleep(2 ** attempt)  # 1s, 2s, 4s, ...
    raise RuntimeError(f"Failed to fetch {url}: {last_err}")


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #

class _TileParser(HTMLParser):
    """Collect product tiles from the refurb category grid.

    Apple renders a no-JavaScript grid of real <a href="/shop/product/..."> tiles
    for SEO/accessibility, so we can read the listing straight from the HTML
    without executing any client-side JavaScript.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tiles = []           # list of {"url": str, "title": str}
        self._depth = 0           # anchor nesting depth while capturing
        self._href = None
        self._parts = []

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return  # non-anchor tags inside a tile are ignored; text still captured
        href = dict(attrs).get("href", "")
        if not self._depth and "/shop/product/" in href:
            # Start capturing a product tile.
            self._depth = 1
            self._href = href
            self._parts = []
        elif self._depth:
            # Nested anchor inside a tile (rare) — count it so we close correctly.
            self._depth += 1

    def handle_endtag(self, tag):
        if tag != "a" or not self._depth:
            return
        self._depth -= 1
        if self._depth == 0:
            title = " ".join(self._parts).replace("‑", "-")  # non-breaking hyphen
            title = re.sub(r"\s+", " ", title).strip()
            self.tiles.append({"url": self._href, "title": title})
            self._href = None
            self._parts = []

    def handle_data(self, data):
        if self._depth:
            text = data.strip()
            if text:
                self._parts.append(text)


def absolutize(url):
    if url.startswith("//"):
        return "https:" + url
    if url.startswith("/"):
        return BASE_URL + url
    return url


def product_key(url):
    """Stable identity for a product: its refurb SKU (e.g. G1JV9LL/A)."""
    m = re.search(r"/shop/product/([^/?#]+(?:/[A-Z])?)", url)
    if m:
        return m.group(1)
    path = urllib.parse.urlsplit(url).path
    return path or url


def extract_tiles(html_text):
    """Return a de-duplicated list of {url, title, key} from grid HTML.

    Primary source is the parsed no-JS grid. As a safety net we also regex every
    /shop/product/ link on the page, so we never miss an item even if Apple
    tweaks the tile markup — such fallback tiles simply arrive with an empty
    title and get their specs from the detail page.
    """
    parser = _TileParser()
    parser.feed(html_text)

    by_key = {}
    for tile in parser.tiles:
        url = absolutize(tile["url"])
        key = product_key(url)
        # Prefer the entry that actually carries a title.
        if key not in by_key or (tile["title"] and not by_key[key]["title"]):
            by_key[key] = {"url": url, "title": tile["title"], "key": key}

    # Safety net: if Apple ever changes the tile markup so the anchor parse
    # finds nothing, fall back to regex-scraping product links off the page.
    if not by_key:
        for raw in re.findall(r'/shop/product/[^"\'\s<>]+', html_text):
            url = absolutize(raw)
            key = product_key(url)
            by_key.setdefault(key, {"url": url, "title": "", "key": key})

    return list(by_key.values())


_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_STYLE_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)


def html_to_text(html_text):
    """Crude tag-strip: enough to keyword-match a detail page's visible text."""
    stripped = _SCRIPT_STYLE_RE.sub(" ", html_text)
    stripped = _TAG_RE.sub(" ", stripped)
    stripped = (
        stripped.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&#8209;", "-")   # non-breaking hyphen Apple uses in "14‑Core"
        .replace("‑", "-")
    )
    return re.sub(r"\s+", " ", stripped).strip()


PRICE_RE = re.compile(r"\$[\d,]+(?:\.\d{2})?")


def find_price(text):
    m = PRICE_RE.search(text or "")
    return m.group(0) if m else ""


# --------------------------------------------------------------------------- #
# Matching
# --------------------------------------------------------------------------- #

def text_matches(text, require_all, exclude_any):
    """True iff every require_all term is present and no exclude_any term is."""
    low = (text or "").lower()
    # Normalise hyphen variants so "M4 Pro"/"M4‑Pro" and "64GB"/"64 GB" both hit.
    low = low.replace("‑", "-")
    if not all(term.lower() in low for term in require_all):
        return False
    if any(term.lower() in low for term in exclude_any):
        return False
    return True


def find_matches(config, html_text, detail_cache=None):
    """Return (matches, all_tiles).

    A tile matches when the combined text of its grid title and — when needed —
    its product detail page satisfies `require_all` and avoids `exclude_any`.
    Detail pages are only fetched for tiles passing the cheap `tile_prefilter`,
    keeping network traffic to a handful of requests per run.
    """
    require_all = config.get("require_all", [])
    exclude_any = config.get("exclude_any", [])
    prefilter = config.get("tile_prefilter", [])
    check_details = config.get("check_detail_pages", True)
    detail_cache = detail_cache if detail_cache is not None else {}

    tiles = extract_tiles(html_text)
    matches = []

    for tile in tiles:
        combined = tile["title"]
        price = find_price(tile["title"])
        matched = text_matches(combined, require_all, exclude_any)

        # If the grid title alone doesn't decide it, consult the detail page —
        # but only for tiles worth inspecting (the prefilter, e.g. "M4 Pro").
        need_detail = (
            not matched
            and check_details
            and text_matches(tile["title"], prefilter, exclude_any)
        )
        if need_detail:
            try:
                if tile["key"] not in detail_cache:
                    detail_cache[tile["key"]] = html_to_text(fetch(tile["url"]))
                detail_text = detail_cache[tile["key"]]
                combined = tile["title"] + " \n " + detail_text
                price = find_price(tile["title"]) or find_price(detail_text)
                matched = text_matches(combined, require_all, exclude_any)
            except Exception as exc:  # noqa: BLE001 - detail fetch is best-effort
                # Log (don't crash): we'll simply retry this candidate next run.
                print(f"  ! detail fetch failed for {tile['url']}: {exc}",
                      file=sys.stderr)

        tile["price"] = price
        tile["matched"] = matched
        tile["inspected_detail"] = need_detail
        if matched:
            matches.append({
                "key": tile["key"],
                "title": tile["title"] or "(refurbished Mac)",
                "price": price,
                "url": tile["url"],
            })

    return matches, tiles


# --------------------------------------------------------------------------- #
# State (de-duplication across runs)
# --------------------------------------------------------------------------- #

def load_state(path):
    if path and os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except (json.JSONDecodeError, OSError):
            pass
    return {"in_stock": {}}


def save_state(path, state):
    if not path:
        return
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
    os.replace(tmp, path)


# --------------------------------------------------------------------------- #
# Notifications
# --------------------------------------------------------------------------- #

def build_message(matches):
    n = len(matches)
    subject = f"✅ In stock: {n} matching refurbished Mac{'s' if n != 1 else ''}"
    lines = ["Matching refurbished items are now in stock:\n"]
    for m in matches:
        price = f" — {m['price']}" if m["price"] else ""
        lines.append(f"• {m['title']}{price}\n  {m['url']}\n")
    lines.append("\n(Apple refurbished stock sells out fast — grab it quickly.)")
    return subject, "\n".join(lines)


def send_email(cfg, subject, body):
    host = cfg["smtp_host"]
    port = int(cfg.get("smtp_port", 465))
    security = cfg.get("smtp_security", "ssl").lower()
    username = cfg.get("username", "")
    password = resolve_secret(cfg.get("password", ""))
    from_addr = cfg.get("from_addr") or username
    to_addrs = cfg["to_addrs"]

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = ", ".join(to_addrs)
    msg.set_content(body)

    context = ssl.create_default_context()
    if security == "ssl":
        with smtplib.SMTP_SSL(host, port, context=context, timeout=30) as smtp:
            if username:
                smtp.login(username, password)
            smtp.send_message(msg)
    else:  # starttls / plain
        with smtplib.SMTP(host, port, timeout=30) as smtp:
            if security == "starttls":
                smtp.starttls(context=context)
            if username:
                smtp.login(username, password)
            smtp.send_message(msg)


def send_twilio(cfg, body):
    import base64

    sid = cfg["account_sid"]
    token = resolve_secret(cfg["auth_token"])
    from_number = cfg["from_number"]
    to_numbers = cfg["to_numbers"]
    endpoint = f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
    auth_header = "Basic " + base64.b64encode(f"{sid}:{token}".encode()).decode()

    for to_number in to_numbers:
        data = urllib.parse.urlencode({
            "From": from_number,
            "To": to_number,
            "Body": body,
        }).encode()
        req = urllib.request.Request(endpoint, data=data)
        req.add_header("Authorization", auth_header)
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()


def send_desktop(cfg, subject, body):
    """macOS Notification Center via osascript (no-op elsewhere)."""
    if sys.platform != "darwin":
        return
    first_line = body.strip().splitlines()[0] if body.strip() else ""
    title = cfg.get("title", "Apple Refurb Checker")
    script = (
        f'display notification {json.dumps(first_line or subject)} '
        f'with title {json.dumps(title)} '
        f'subtitle {json.dumps(subject)} sound name "Glass"'
    )
    subprocess.run(["osascript", "-e", script], check=False)


def notify(config, subject, body):
    """Send through every configured channel; a failing channel never blocks others."""
    channels = config.get("notifications", {})
    sent, errors = [], []

    if channels.get("email", {}).get("enabled"):
        try:
            send_email(channels["email"], subject, body)
            sent.append("email")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"email: {exc}")

    if channels.get("twilio", {}).get("enabled"):
        try:
            send_twilio(channels["twilio"], f"{subject}\n\n{body}")
            sent.append("sms")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"sms: {exc}")

    desktop = channels.get("desktop", {})
    if desktop.get("enabled"):
        try:
            send_desktop(desktop, subject, body)
            sent.append("desktop")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"desktop: {exc}")

    if sent:
        print(f"  notified via: {', '.join(sent)}")
    for err in errors:
        print(f"  ! notify error {err}", file=sys.stderr)
    return sent, errors


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #

def get_feed_html(config, from_file=None):
    if from_file:
        with open(from_file, "r", encoding="utf-8") as fh:
            return fh.read()
    return fetch(config["feed_url"])


def run_check(config, from_file=None):
    """One check cycle: fetch, match, diff against state, notify on new matches."""
    html_text = get_feed_html(config, from_file)
    matches, tiles = find_matches(config, html_text)

    state_path = config.get("state_file")
    if state_path and not os.path.isabs(state_path):
        state_path = os.path.join(SCRIPT_DIR, state_path)
    state = load_state(state_path)
    previously = state.get("in_stock", {})

    current = {m["key"]: m for m in matches}
    new_matches = [m for k, m in current.items() if k not in previously]

    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] scanned {len(tiles)} tiles, {len(matches)} match "
          f"criteria, {len(new_matches)} new.")

    if new_matches:
        subject, body = build_message(new_matches)
        print(subject)
        for m in new_matches:
            print(f"  + {m['title']} {m['price']} {m['url']}")
        if not from_file:
            notify(config, subject, body)
        else:
            print("  (--from-file: notifications skipped)")

    state["in_stock"] = current
    state["last_checked"] = ts
    if not from_file:
        save_state(state_path, state)

    return new_matches


def cmd_list(config, from_file=None):
    """Print every tile and whether it matches — for calibrating your keywords."""
    html_text = get_feed_html(config, from_file)
    matches, tiles = find_matches(config, html_text)
    print(f"Found {len(tiles)} tiles on {config['feed_url']}:\n")
    for t in sorted(tiles, key=lambda x: (not x["matched"], x["title"])):
        mark = "✅ MATCH" if t["matched"] else "        "
        detail = " [checked detail]" if t.get("inspected_detail") else ""
        title = t["title"] or t["key"]
        # Avoid printing the price twice when it's already inside the tile title.
        price = f"  {t['price']}" if t.get("price") and t["price"] not in title else ""
        print(f"{mark} {title}{price}{detail}")
        print(f"          {t['url']}")
    print(f"\n{len(matches)} of {len(tiles)} tiles match your criteria "
          f"(require_all={config.get('require_all')}).")


def cmd_test_notify(config):
    subject = "🔔 Test: Apple Refurb Checker"
    body = ("This is a test notification from your Apple refurbished stock "
            "checker. If you received this, your notification channels work.")
    sent, errors = notify(config, subject, body)
    if not sent and not errors:
        print("No notification channels are enabled in config.json.")
    return not errors


# --------------------------------------------------------------------------- #
# Entrypoint
# --------------------------------------------------------------------------- #

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=os.path.join(SCRIPT_DIR, "config.json"),
                    help="Path to config.json (default: alongside this script).")
    ap.add_argument("--list", action="store_true",
                    help="Print all tiles and whether they match; do not notify.")
    ap.add_argument("--from-file", metavar="HTML",
                    help="Parse a saved HTML file instead of fetching (testing).")
    ap.add_argument("--loop", type=int, metavar="SECONDS",
                    help="Run forever, checking every SECONDS (else run once).")
    ap.add_argument("--test-notify", action="store_true",
                    help="Send a test message through every configured channel.")
    args = ap.parse_args(argv)

    config = load_config(args.config)

    if args.test_notify:
        return 0 if cmd_test_notify(config) else 1

    if args.list:
        cmd_list(config, from_file=args.from_file)
        return 0

    if args.loop:
        print(f"Looping every {args.loop}s. Ctrl-C to stop.")
        while True:
            try:
                run_check(config, from_file=args.from_file)
            except Exception as exc:  # noqa: BLE001 - keep the loop alive
                print(f"  ! check failed: {exc}", file=sys.stderr)
            time.sleep(args.loop)

    run_check(config, from_file=args.from_file)
    return 0


if __name__ == "__main__":
    sys.exit(main())
