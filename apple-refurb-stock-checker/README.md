# Apple Refurbished Stock Checker

Watches Apple's **Certified Refurbished** store and alerts you the moment a
matching item is in stock. Preconfigured for a **Mac mini with M4 Pro and 64 GB
RAM**, but the criteria are just keywords — retarget it at any refurb product.

- **Pure Python 3 standard library** — nothing to `pip install`.
- Runs on your iMac under **launchd** (or cron), checking every 15 minutes.
- Notifies by **email**, **SMS** (Twilio or a carrier email‑to‑SMS gateway),
  and/or a **macOS desktop notification**.
- **Restock‑aware**: alerts only on newly in‑stock matches, and re‑alerts if an
  item sells out and later returns.

Apple's refurb inventory is limited and sells out fast — this exists so you find
out in minutes, not whenever you next happen to check.

---

## Why it checks detail pages

The refurb *grid* tile for a Mac often lists the chip (`M4 Pro`) but **not the
RAM** — every RAM/SSD configuration shares the same tile title. So the checker
does two things:

1. Scans the category grid for candidate tiles (default prefilter: `M4 Pro`).
2. For each candidate, opens its product page and confirms the full spec
   (`64GB`) against the tech specs there.

That's why the default `require_all` is `["Mac mini", "M4 Pro", "64GB"]` and
`check_detail_pages` is `true`. It only opens a page or two per run.

---

## Setup on your iMac

### 1. Get the files onto the Mac

Copy this `apple-refurb-stock-checker/` folder somewhere stable, e.g.
`~/apple-refurb-stock-checker`. You need Python 3 (check with `python3
--version`; if missing, run `xcode-select --install`).

### 2. Create your config

```bash
cd ~/apple-refurb-stock-checker
cp config.example.json config.json
```

Edit `config.json`. The important parts:

| Field | Meaning |
|---|---|
| `feed_url` | The refurb category page. Default is the US Mac mini page. |
| `require_all` | **All** of these words must appear for a match (case‑insensitive). Default `["Mac mini", "M4 Pro", "64GB"]`. |
| `exclude_any` | If any of these appear, skip it (e.g. `["10-Core CPU"]`). |
| `tile_prefilter` | Only open detail pages for grid tiles matching these — keeps it fast. Default `["M4 Pro"]`. |
| `check_detail_pages` | Open product pages to confirm specs not shown on the grid. Keep `true` for the RAM check. |

> Targeting a different machine? Point `feed_url` at that category
> (e.g. `.../shop/refurbished/mac/macbook-pro`) and change `require_all`.
> Outside the US, prefix the path with your locale, e.g.
> `https://www.apple.com/uk/shop/refurbished/mac/mac-mini`.

### 3. Set up notifications

Enable any combination in `config.json` → `notifications`.

**Desktop notification** (simplest, on by default) — a macOS banner with sound.
Nothing to configure.

**Email (Gmail example).** Gmail needs an **App Password**, not your normal
password (requires 2‑Step Verification):
<https://myaccount.google.com/apppasswords>. Then in `config.json` the email
block already points `username`/`from_addr`/`to_addrs` at your address, with:

```json
"password": "env:REFURB_SMTP_PASSWORD"
```

`env:NAME` reads the secret from an environment variable so it never sits in the
file. Test it from a shell that has the variable set:

```bash
export REFURB_SMTP_PASSWORD='your-app-password'
python3 refurb_checker.py --test-notify
```

Other providers: set `smtp_host`, `smtp_port` (`465` SSL or `587` STARTTLS),
and `smtp_security` (`ssl` / `starttls`).

**SMS — two options:**

- *Carrier email‑to‑SMS gateway (free):* add your phone's gateway address to the
  email `to_addrs`, e.g. `"5551234567@vtext.com"` (Verizon),
  `@tmomail.net` (T‑Mobile), `@txt.att.net` (AT&T). No Twilio needed. (Some
  carriers are phasing these out; if texts don't arrive, use Twilio.)
- *Twilio (reliable):* set `notifications.twilio.enabled` to `true` and fill in
  `account_sid`, `auth_token` (use `env:TWILIO_AUTH_TOKEN`), `from_number`
  (your Twilio number), and `to_numbers`.

Verify everything with:

```bash
python3 refurb_checker.py --test-notify
```

### 4. Calibrate the match (recommended first run)

See exactly what's on the page and what matches, before automating:

```bash
python3 refurb_checker.py --list
```

Every tile prints with `✅ MATCH` or blank. Tweak `require_all` /
`exclude_any` until only the configs you want are flagged.

### 5. Schedule it with launchd

Edit `com.user.apple-refurb-checker.plist` — replace every `USERNAME`/path
marked `>>>` with your real home path, and put your app password in the
`EnvironmentVariables` block (launchd does **not** read your shell profile).
Then:

```bash
cp com.user.apple-refurb-checker.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.user.apple-refurb-checker.plist
```

It now runs every 15 minutes (adjust `StartInterval`), logging to
`checker.log`. After editing the plist or config, reload:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.apple-refurb-checker.plist
launchctl load   ~/Library/LaunchAgents/com.user.apple-refurb-checker.plist
```

Prefer cron? Add: `*/15 * * * * cd ~/apple-refurb-stock-checker && REFURB_SMTP_PASSWORD=... /usr/bin/python3 refurb_checker.py >> checker.log 2>&1`

---

## Usage reference

```bash
python3 refurb_checker.py                 # one check (what launchd runs)
python3 refurb_checker.py --list          # show all tiles + match status
python3 refurb_checker.py --loop 900      # run continuously, every 15 min
python3 refurb_checker.py --test-notify   # test every configured channel
python3 refurb_checker.py --from-file page.html --list   # offline parser test
python3 refurb_checker.py --config /path/to/config.json  # custom config path
```

`--loop` is an alternative to launchd if you'd rather keep a Terminal/`tmux`
session running instead of a scheduled job.

## How matching & de‑duplication work

- A tile matches when the combined text of its grid title and (when needed) its
  product detail page contains **all** `require_all` terms and **none** of
  `exclude_any`. `M4 Pro`/`M4‑Pro` and `64GB`/`64 GB` are normalized so spacing
  and hyphen style don't matter.
- `state.json` records what's currently in stock. You're alerted only about keys
  (refurb SKUs) that weren't in stock last run — so no repeat spam, but a sold‑out
  item that comes back **does** alert again. Delete `state.json` to reset.

## Troubleshooting

- **`403 Forbidden` when fetching:** you're likely behind a proxy/VPN that
  blocks apple.com, or an IP Apple rate‑limits. It works from a normal home
  connection with the built‑in Safari User‑Agent.
- **No match though the item exists:** run `--list` and check the exact wording;
  adjust `require_all`. Ensure `check_detail_pages` is `true` for RAM matching.
- **Email fails on Gmail:** you must use an **App Password**, not your account
  password, and have 2‑Step Verification on.
- **launchd job not running:** `launchctl list | grep apple-refurb` and read
  `checker.log`. Confirm the plist paths are absolute and correct.

## Files

| File | Purpose |
|---|---|
| `refurb_checker.py` | The checker (stdlib only). |
| `config.example.json` | Template — copy to `config.json`. |
| `com.user.apple-refurb-checker.plist` | launchd schedule for macOS. |
| `config.json`, `state.json` | Your local config and state (gitignored). |

## Note

This scrapes a public web page for personal use and depends on Apple's current
markup; if the page structure changes, run `--list` to see what the parser reads
and adjust. Please keep the interval reasonable (the 15‑minute default is fine)
rather than hammering the site.
