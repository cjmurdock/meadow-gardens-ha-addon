#!/usr/bin/env python3
"""
book_api.py — Chronogolf API-based booking for Meadow Gardens Golf Club

Replaces the Playwright page-navigation approach (book.py) with direct API
calls executed within an authorized Playwright browser session.

Flow:
1.  Check Supabase session_state — skip if paused
2.  Calculate target date (today + 10 days, Vancouver timezone)
3.  Check booking_queue for a pending entry matching that date
4.  Launch Playwright, inject cookies.json, navigate to dashboard
5.  Verify session; pause for the owner if verification or login is needed
6.  Update Supabase session health
7.  Hold until 19:00:01 Vancouver time (saves 4s vs old 19:00:05)
8.  GET /marketplace/clubs/80/teetimes — retry up to 15×1s if response is empty
9.  Filter active slots with enough free_slots; prefer 12:00–14:00 window
10. For up to 15 slots: freeze → options → reservation (201 = success)
11. Update Supabase booking_queue + send ntfy push notification
"""

import asyncio
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests as http_requests
from session import open_dashboard, SessionRequired
from calendar_sync import sync_booking

# B.C. remains UTC-7 year-round from March 8, 2026. Use an explicit
# offset for future bookings so stale system/pytz data cannot delay the
# 19:00 release by an hour after November 1.
BC_TIMEZONE = timezone(timedelta(hours=-7), name="Pacific time")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SUPABASE_URL        = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY        = os.environ.get("SUPABASE_KEY", "")
NTFY_TOPIC          = os.environ.get("NTFY_TOPIC", "")
NTFY_SERVER         = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")

# Meadow Gardens club / course constants
CLUB_ID         = 80
COURSE_ID       = "91"
USER_ID         = int(os.environ.get("CHRONOGOLF_USER_ID") or 0)
MEMBER_TYPE_ID  = 481        # Single Full Play Member
MEMBER_GUEST_ID = 91728      # Member Guest

# Static fallback pricing (used when /reservations/options response is unparseable)
PRODUCT_ID           = 628
PRODUCT_RULE_MEMBER  = 1179778   # member round product rule id
PRODUCT_RULE_GUEST   = 1347950   # guest round product rule id
GUEST_UNIT_PRICE     = 60        # guest green fee (CAD)

async def diagnostic_screenshot(page, path):
    if os.environ.get("BOOKING_PRIVATE_SCREENSHOTS") != "1":
        return
    destination = Path(path)
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        await page.screenshot(path=str(destination), timeout=5000)
    except Exception:
        print("[WARN] Could not save diagnostic screenshot")

# ---------------------------------------------------------------------------
# Supabase helpers (identical to book.py)
# ---------------------------------------------------------------------------

def supabase_get(table, params=None):
    """GET from Supabase REST API."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    if not SUPABASE_KEY.startswith("sb_"):
        headers["Authorization"] = f"Bearer {SUPABASE_KEY}"
    r = http_requests.get(url, headers=headers, params=params or {}, timeout=15)
    r.raise_for_status()
    return r.json()


def supabase_patch(table, match_params, data):
    """PATCH (update) rows in Supabase."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    if not SUPABASE_KEY.startswith("sb_"):
        headers["Authorization"] = f"Bearer {SUPABASE_KEY}"
    r = http_requests.patch(url, headers=headers, params=match_params, json=data, timeout=15)
    r.raise_for_status()
    return r.json()


# ---------------------------------------------------------------------------
# Notifications (identical to book.py)
# ---------------------------------------------------------------------------

def send_ntfy(message, title="Meadow Gardens Booking", priority="high", tags=None):
    """Send push notification via ntfy.sh."""
    if not NTFY_TOPIC:
        print("[NTFY] Not configured")
        return
    safe_title = title.encode("ascii", errors="replace").decode("ascii")
    headers = {"Title": safe_title, "Priority": priority}
    if tags:
        headers["Tags"] = tags
    if os.environ.get("NTFY_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['NTFY_TOKEN']}"
    try:
        resp = http_requests.post(
            f"{NTFY_SERVER}/{NTFY_TOPIC}",
            data=message.encode("utf-8"),
            headers=headers,
            timeout=10,
        )
        if resp.status_code == 200:
            print(f"[NTFY] Sent: {message}")
        else:
            print(f"[NTFY] Unexpected status {resp.status_code}: {resp.text[:100]}")
    except Exception as e:
        print(f"[NTFY] Failed to send: {type(e).__name__}")


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

def parse_start_time(t24):
    """Convert '13:30' → (810, '1:30 PM')."""
    h, m = map(int, t24.split(":"))
    total = h * 60 + m
    period = "AM" if h < 12 else "PM"
    h12 = h % 12 or 12
    display = f"{h12}:{m:02d} {period}"
    return total, display


def time_window_minutes(time_str):
    """Convert 'HH:MM' to total minutes past midnight."""
    h, m = map(int, time_str.split(":"))
    return h * 60 + m


# ---------------------------------------------------------------------------
# JavaScript for page.evaluate() — teetimes fetch with retry
# ---------------------------------------------------------------------------

# Called once after 19:00:01. Retries up to maxRetries times with retryMs
# delay between attempts if the server returns an empty array (common at
# exactly 7 PM when Chronogolf is under heavy load).
# Returns: { ok: bool, teetimes: [...], attempt: int }
JS_GET_TEETIMES = """
async (args) => {
    const { date, courseId, memberTypeId, guestTypeId, maxRetries, retryMs } = args;
    const url = '/marketplace/clubs/80/teetimes?date=' + date
              + '&course_id=' + courseId
              + '&affiliation_type_ids[]=' + memberTypeId
              + '&affiliation_type_ids[]=' + guestTypeId
              + '&nb_holes=18';

    for (let i = 0; i < maxRetries; i++) {
        try {
            const r = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(5000) });
            if ([401, 403, 429].includes(r.status) || r.redirected || r.headers.get('cf-mitigated') === 'challenge') {
                return { ok: false, accessBlocked: true, where: 'listing', attempt: i + 1, status: r.status,
                         redirected: r.redirected, url: new URL(r.url).pathname, cf: r.headers.get('cf-mitigated') };
            }
            if (r.ok) {
                const data = await r.json();
                if (data && data.length > 0) {
                    return { ok: true, teetimes: data, attempt: i + 1 };
                }
                console.log('[API] Teetimes attempt ' + (i + 1) + '/' + maxRetries + ': HTTP ' + r.status + ', empty array');
            } else {
                console.log('[API] Teetimes attempt ' + (i + 1) + '/' + maxRetries + ': HTTP ' + r.status);
            }
        } catch (e) {
            console.log('[API] Teetimes attempt ' + (i + 1) + '/' + maxRetries + ': ' + e.message);
        }
        if (i < maxRetries - 1) {
            await new Promise(res => setTimeout(res, retryMs));
        }
    }
    return { ok: false, teetimes: [], attempt: maxRetries };
}
"""

# ---------------------------------------------------------------------------
# JavaScript for page.evaluate() — freeze + options + reservation
# ---------------------------------------------------------------------------

# Executes the full 3-step booking sequence for a single teetime slot:
#   1. POST /private_api/teetimes/{id}/freeze
#   2. POST /marketplace/reservations/options  (extracts product_rule_ids dynamically;
#      falls back to static values if parsing fails)
#   3. POST /marketplace/reservations          (201 = success)
#
# Returns: { ok, step, status, ref, error, memberProductRuleId, guestProductRuleId }
JS_BOOK_SLOT = """
async (args) => {
    const {
        teetimeId, playerCount, userId,
        memberTypeId, guestTypeId,
        clubId, productId,
        productRuleMember, productRuleGuest, guestUnitPrice
    } = args;

    /* Helper: read current CSRF token.
     * Chronogolf's AngularJS app stores it in $http.defaults.headers.common,
     * NOT in a <meta name="csrf-token"> tag (that tag is absent on the dashboard SPA).
     * We try both paths to be safe. */
    const getCsrf = () => {
        // Path 1: AngularJS $http defaults (primary on dashboard)
        try {
            const injector = angular.element(document.body).injector();
            const h = injector.get('$http').defaults.headers;
            const t = (h.common && h.common['X-CSRF-Token'])
                   || (h.post   && h.post['X-CSRF-Token'])
                   || (h.common && h.common['X-Csrf-Token']);
            if (t) return t;
        } catch (e) { /* angular not ready or different page */ }
        // Path 2: Rails meta tag fallback
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.content : null;
    };

    const baseHeaders = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    };
    const accessBlocked = (response) => [401, 403, 429].includes(response.status)
        || response.redirected || response.headers.get('cf-mitigated') === 'challenge';
    const blocked = (where, response) => ({
        accessBlocked: true, where, status: response.status, redirected: response.redirected,
        url: new URL(response.url).pathname, cf: response.headers.get('cf-mitigated')
    });

    /* ---- Step 1: Freeze slot ---- */
    const csrf1 = getCsrf();
    if (!csrf1) return { ok: false, step: 'csrf', error: 'No CSRF token found on page' };

    const freezeResp = await fetch('/private_api/teetimes/' + teetimeId + '/freeze', {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        headers: { ...baseHeaders, 'X-CSRF-Token': csrf1 },
        body: '{}'
    });
    if (accessBlocked(freezeResp)) return blocked('freeze', freezeResp);
    if (!freezeResp.ok) {
        return {
            ok: false, step: 'freeze',
            status: freezeResp.status,
            error: 'Freeze returned HTTP ' + freezeResp.status
        };
    }

    /* ---- Step 2: Get options (dynamic product_rule_ids and unit_prices) ---- */
    let memberProductRuleId = productRuleMember;
    let guestProductRuleId  = productRuleGuest;
    let memberUnitPriceDyn  = 0;            // member green fee is always free
    let guestUnitPriceDyn   = guestUnitPrice; // static fallback; overridden below

    try {
        const csrf2 = getCsrf() || csrf1;
        const roundsForOpts = [
            { affiliation_type_id: String(memberTypeId), extras: [], discounts: [] }
        ];
        for (let i = 1; i < playerCount; i++) {
            roundsForOpts.push({
                affiliation_type_id: String(guestTypeId), extras: [], discounts: []
            });
        }
        const optsResp = await fetch('/marketplace/reservations/options', {
            method: 'POST',
            signal: AbortSignal.timeout(10000),
            headers: { ...baseHeaders, 'X-CSRF-Token': csrf2 },
            body: JSON.stringify({
                nb_holes: '18',
                rounds_attributes: roundsForOpts,
                source: 'chronogolf',
                medium: 'dashboard',
                teetime_id: String(teetimeId)
            })
        });
        if (accessBlocked(optsResp)) return blocked('options', optsResp);
        if (optsResp.ok) {
            const opts = await optsResp.json();
            /* The options endpoint returns an ARRAY; grab the first element. */
            const optsData = Array.isArray(opts) ? opts[0] : opts;
            if (optsData) {
                /* Response uses 'rounds' + 'round_lines' (not rounds_attributes / round_lines_attributes) */
                const rounds = optsData.rounds || optsData.rounds_attributes || [];
                const extractInfo = (r) => {
                    const rls = r.round_lines || r.round_lines_attributes || [];
                    const info = {};
                    if (rls.length > 0) {
                        if (rls[0].product_rule_id)      info.ruleId    = rls[0].product_rule_id;
                        if (rls[0].unit_price !== undefined) info.unitPrice = rls[0].unit_price;
                    }
                    /* Direct field fallback */
                    if (!info.ruleId && r.product_rule_id) info.ruleId = r.product_rule_id;
                    return info;
                };
                if (rounds.length >= 1) {
                    const info = extractInfo(rounds[0]);
                    if (info.ruleId)    memberProductRuleId = info.ruleId;
                    /* member is always free — ignore unit_price from options */
                }
                if (rounds.length >= 2) {
                    const info = extractInfo(rounds[1]);
                    if (info.ruleId)                  guestProductRuleId = info.ruleId;
                    if (info.unitPrice !== undefined) guestUnitPriceDyn  = info.unitPrice;
                }
            }
        }
    } catch (e) {
        /* Options failed — static fallbacks already set above */
        console.log('[API] Options fetch error: ' + e.message + ' — using static fallbacks');
    }

    /* ---- Step 3: Build rounds_attributes (HAR-derived structure) ---- */
    const buildRound = (affTypeId, roundUserId, requiresPayment, productRuleId, unitPrice) => ({
        id: null,
        affiliation_type_id: affTypeId,
        guest: null,
        reservation_id: null,
        state: 'reserved',
        raincheck_issued_at: null,
        user_id: roundUserId,
        cancelled_at: null,
        requires_payment: requiresPayment,
        check_in_medium: null,
        check_in_kiosk_id: null,
        checked_in_at: null,
        fully_refunded: false,
        round_lines_attributes: [{
            id: null,
            round_id: null,
            discount_id: null,
            discount_rule_id: null,
            kit_id: null,
            kit_reference: null,
            product_id: productId,
            product_rule_id: productRuleId,
            original_unit_price: unitPrice,
            unit_price: unitPrice,
            quantity: 1,
            refunded_at: null,
            refundable: false,
            unit_quantity: 1
        }]
    });

    const rounds = [buildRound(memberTypeId, userId, false, memberProductRuleId, 0)];
    for (let i = 1; i < playerCount; i++) {
        rounds.push(buildRound(guestTypeId, null, true, guestProductRuleId, guestUnitPriceDyn));
    }

    /* ---- Step 4: Create reservation ---- */
    const csrf3 = getCsrf() || csrf1;
    const reservPayload = {
        reservation: {
            club_id: clubId,
            teetime_id: teetimeId,
            recurrence_id: null,
            state: 'confirmed',
            holes: 18,
            eligible_for_mobile_self_check_in: false,
            made_online: true,
            origin_reservation_id: null,
            created_user_id: null,
            reminder_chronodeal_chosen_at: null,
            source: 'chronogolf',
            online_note: null,
            booking_reference: null,
            confirmed_at: null,
            cancellable: true,
            editable: true,
            force_online_payment: false,
            discount_type: null,
            club: { id: clubId, name: 'Meadow Gardens Golf Club', currency_code: 'CAD' },
            lottery_choices_attributes: null,
            rounds_attributes: rounds,
            payment_source_id: null,
            payment_source_type: null,
            medium: 'dashboard',
            booking_engine: 1
        }
    };

    const reservResp = await fetch('/marketplace/reservations', {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        headers: { ...baseHeaders, 'X-CSRF-Token': csrf3 },
        body: JSON.stringify(reservPayload)
    });

    if (accessBlocked(reservResp)) return blocked('reservation', reservResp);
    let ref = null;

    if (reservResp.status === 201) {
        try {
            const body = await reservResp.json();
            ref = body.booking_reference || null;
        } catch (e) {}
    }

    return {
        ok: reservResp.status === 201,
        step: 'reservation',
        status: reservResp.status,
        ref,
        error: reservResp.status !== 201
               ? ('Reservation returned HTTP ' + reservResp.status)
               : null,
        memberProductRuleId,
        guestProductRuleId
    };
}
"""

# ---------------------------------------------------------------------------
# Main booking coroutine
# ---------------------------------------------------------------------------

async def book_tee_time_api(date_str, time_start, time_end, player_count):
    """
    Book a tee time via direct API calls (page.evaluate fetch).
    Returns dict: { success, time, ref, error }
    """
    from playwright.async_api import async_playwright

    result = {"success": False, "time": None, "ref": None, "error": None}
    screenshot_prefix = str(Path(os.environ.get("BOOKING_STATE_DIR", ".")) / "screenshots" / date_str)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1920, "height": 1080},
            locale="en-CA",
            timezone_id="Etc/GMT+7",  # IANA fixed UTC-7 (Etc sign is reversed)
        )
        page = None

        try:
            # ------------------------------------------------------------
            # STEP 1: LOGIN via cookies.json
            # ------------------------------------------------------------
            page = await open_dashboard(context)
            print("[STEP 1] Dashboard reached")
            await diagnostic_screenshot(page, f"{screenshot_prefix}_01_dashboard.png")

            # Update Supabase session health
            supabase_patch("session_state", {"id": "eq.1"}, {
                "is_healthy": True,
                "last_login": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })

            # ------------------------------------------------------------
            # STEP 2: HOLD UNTIL 19:00:01 VANCOUVER TIME
            # Open the dashboard early and wait for the release.
            # ------------------------------------------------------------
            now_van = datetime.now(BC_TIMEZONE)
            target_open = now_van.replace(hour=19, minute=0, second=1, microsecond=0)

            if now_van < target_open:
                wait_secs = (target_open - now_van).total_seconds()
                print(f"[HOLD] Waiting {wait_secs:.1f}s until 19:00:01 Vancouver time...")
                await page.wait_for_timeout(int(wait_secs * 1000))
                print("[HOLD] 19:00:01 reached — firing API calls now")
            else:
                print(f"[HOLD] Already past 19:00:01 ({now_van.strftime('%H:%M:%S')}) — proceeding immediately")

            # ------------------------------------------------------------
            # STEP 3: FETCH TEE TIMES (JS fetch, 15×1s retry if empty)
            # ------------------------------------------------------------
            print(f"[STEP 3] Fetching tee times for {date_str}...")
            tt_result = await page.evaluate(
                JS_GET_TEETIMES,
                {
                    "date":          date_str,
                    "courseId":      COURSE_ID,
                    "memberTypeId":  MEMBER_TYPE_ID,
                    "guestTypeId":   MEMBER_GUEST_ID,
                    "maxRetries":    15,
                    "retryMs":       1000,
                },
            )
            if tt_result.get("accessBlocked"):
                detail = describe_block(tt_result)
                print(f"[BLOCKED] {detail}")
                raise SessionRequired(f"Chronogolf blocked the {detail}; check manually")
            await diagnostic_screenshot(page, f"{screenshot_prefix}_03_after_teetimes.png")

            if not tt_result.get("ok"):
                result["error"] = "No tee times returned after 15 retries"
                return result

            teetimes = tt_result["teetimes"]
            print(f"[STEP 3] Got {len(teetimes)} tee times (attempt {tt_result.get('attempt', '?')})")

            # ------------------------------------------------------------
            # STEP 4: FILTER AND SORT SLOTS
            # ------------------------------------------------------------
            start_mins = time_window_minutes(time_start)
            end_mins   = time_window_minutes(time_end)

            slots = []
            for t in teetimes:
                # Availability: out_of_capacity=False means bookable for the requested players.
                # The teetimes listing endpoint does NOT include 'active' or 'free_slots' fields;
                # 'out_of_capacity' is the correct signal derived from the query parameters.
                if t.get("out_of_capacity"):
                    continue
                # Skip shotgun/event formats — only book normal tee times
                if t.get("format") not in ("normal", None):
                    continue
                total_mins, display = parse_start_time(t["start_time"])
                slots.append({
                    "id":            t["id"],
                    "total_minutes": total_mins,
                    "display":       display,
                    "start_time":    t["start_time"],
                })

            if not slots:
                result["error"] = "No active slots with enough free_slots found"
                return result

            # Prefer slots inside window (earliest first), then others (earliest first)
            window_slots = sorted(
                [s for s in slots if start_mins <= s["total_minutes"] <= end_mins],
                key=lambda s: s["total_minutes"],
            )
            other_slots = sorted(
                [s for s in slots if not (start_mins <= s["total_minutes"] <= end_mins)],
                key=lambda s: s["total_minutes"],
            )
            ordered_slots = window_slots + other_slots

            if window_slots:
                print(f"[STEP 4] {len(window_slots)} slot(s) in {time_start}–{time_end} window, {len(other_slots)} outside")
            else:
                print(f"[STEP 4] No slots in window — will use first available")

            for s in ordered_slots[:15]:
                marker = "✓" if start_mins <= s["total_minutes"] <= end_mins else " "
                print(f"  [{marker}] {s['display']}  id={s['id']}")

            # ------------------------------------------------------------
            # STEP 5: TRY UP TO 15 SLOTS
            # ------------------------------------------------------------
            for attempt_num, slot in enumerate(ordered_slots[:15], 1):
                print(f"\n[STEP 5] Attempt {attempt_num}/15 — {slot['display']} (id={slot['id']})...")

                book_result = await page.evaluate(
                    JS_BOOK_SLOT,
                    {
                        "teetimeId":          slot["id"],
                        "playerCount":        player_count,
                        "userId":             USER_ID,
                        "memberTypeId":       MEMBER_TYPE_ID,
                        "guestTypeId":        MEMBER_GUEST_ID,
                        "clubId":             CLUB_ID,
                        "productId":          PRODUCT_ID,
                        "productRuleMember":  PRODUCT_RULE_MEMBER,
                        "productRuleGuest":   PRODUCT_RULE_GUEST,
                        "guestUnitPrice":     GUEST_UNIT_PRICE,
                    },
                )

                if book_result.get("accessBlocked"):
                    detail = describe_block(book_result)
                    print(f"[BLOCKED] {detail}")
                    raise SessionRequired(f"Chronogolf blocked the {detail}; check manually")
                if book_result.get("ok"):
                    result["success"] = True
                    result["time"]    = slot["display"]
                    result["ref"]     = book_result.get("ref")
                    print(
                        f"[STEP 5] SUCCESS — booked {slot['display']}"
                        + (f" | ref={result['ref']}" if result["ref"] else "")
                        + f" | memberRule={book_result.get('memberProductRuleId')}"
                        + f" | guestRule={book_result.get('guestProductRuleId')}"
                    )
                    await diagnostic_screenshot(page, f"{screenshot_prefix}_05_success.png")
                    break
                else:
                    step   = book_result.get("step", "unknown")
                    status = book_result.get("status", "?")
                    error  = book_result.get("error") or "unknown error"
                    print(f"[STEP 5] Slot {slot['display']} failed: step={step} HTTP={status} — {error[:200]}")
                    await diagnostic_screenshot(page, f"{screenshot_prefix}_05_fail_{attempt_num}.png")
                    result["error"] = error  # overwritten on each failure; final value used if all fail
                    if step == "reservation" and (not isinstance(status, int) or status >= 500):
                        result["error"] = "Reservation response uncertain; check Chronogolf before retrying"
                        break

            if not result["success"]:
                print(f"[STEP 5] All {min(15, len(ordered_slots))} slot attempts failed")

        except SessionRequired as exc:
            result["error"] = str(exc)
            pause_for_session(str(exc))
        except Exception as exc:
            import traceback
            tb = traceback.format_exc()
            print(f"[ERROR] {exc}\n{tb}")
            result["error"] = f"{type(exc).__name__}: {exc}"
            try:
                if page:
                    await diagnostic_screenshot(page, f"{screenshot_prefix}_error.png")
            except Exception:
                pass
            try:
                supabase_patch("session_state", {"id": "eq.1"}, {
                    "is_healthy":   False,
                    "last_failure": datetime.now(timezone.utc).isoformat(),
                    "updated_at":   datetime.now(timezone.utc).isoformat(),
                })
            except Exception:
                pass

        finally:
            await browser.close()

    return result


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def describe_block(d):
    parts = [f"{d.get('where', '?')} request", f"HTTP {d.get('status', '?')}"]
    if d.get("cf"):
        parts.append(f"cf-mitigated={d['cf']}")
    if d.get("redirected"):
        parts.append(f"redirected to {d.get('url')}")
    elif d.get("url"):
        parts.append(f"at {d['url']}")
    if d.get("attempt"):
        parts.append(f"attempt {d['attempt']}")
    return ", ".join(parts)


def pause_for_session(reason):
    now = datetime.now(timezone.utc).isoformat()
    try:
        supabase_patch("session_state", {"id": "eq.1"}, {
            "is_paused": True, "is_healthy": False, "pause_reason": reason,
            "last_failure": now, "updated_at": now,
        })
    except Exception:
        print("[WARN] Could not update session pause state")


async def main():
    print("=" * 60)
    print(f"Chronogolf API Booking — {datetime.now()}")
    print("=" * 60)

    # Validate environment
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("[FATAL] SUPABASE_URL and SUPABASE_KEY must be set")
        sys.exit(1)
    if not USER_ID or not os.environ.get("CHRONOGOLF_COOKIES_FILE"):
        print("[FATAL] CHRONOGOLF_USER_ID and CHRONOGOLF_COOKIES_FILE must be set")
        sys.exit(1)
    if os.environ.get("BOOKING_LIVE_ENABLED") != "1":
        print("[SAFE] Live booking disabled; no queue reads or writes were made")
        return

    # 1. Check if system is paused
    print("\n[CHECK] Session state...")
    try:
        session_rows = supabase_get("session_state", {"id": "eq.1"})
        if session_rows and session_rows[0].get("is_paused"):
            reason = session_rows[0].get("pause_reason", "Unknown")
            print(f"[PAUSED] System is paused: {reason}")
            return
    except Exception as e:
        print(f"[ERROR] Could not check session state: {type(e).__name__}")
        send_ntfy("Could not check booking pause status; no booking attempted.", title="Booking Error", tags="x")
        return

    # 2. Get booking advance days from settings
    try:
        settings = supabase_get("app_settings", {"key": "eq.booking_advance_days"})
        advance_days = int(settings[0]["value"]) if settings else 10
    except Exception:
        advance_days = 10

    # 3. Calculate target date (Vancouver timezone)
    now_van = datetime.now(BC_TIMEZONE)
    target_date = (now_van + timedelta(days=advance_days)).strftime("%Y-%m-%d")
    print(f"[TARGET] Date: {target_date} (today + {advance_days} days)")

    # 4. Check queue for pending entry matching target date
    try:
        queue = supabase_get("booking_queue", {
            "play_date": f"eq.{target_date}",
            "status":    "eq.pending",
        })
    except Exception as e:
        print(f"[ERROR] Could not query booking queue: {e}")
        send_ntfy(f"Database error: {e}", title="Booking Error", tags="x")
        return

    if not queue:
        print(f"[SKIP] No pending booking for {target_date}")
        return

    booking     = queue[0]
    booking_id  = booking["id"]
    time_start  = booking.get("time_window_start", "12:00")
    time_end    = booking.get("time_window_end",   "14:00")
    player_count = booking.get("player_count", 2)

    print(f"\n[BOOKING] {target_date} | {time_start}–{time_end} | {player_count} players | id={booking_id}")

    # 5. Mark as processing
    claimed = supabase_patch("booking_queue", {"id": f"eq.{booking_id}", "status": "eq.pending"}, {
        "status": "processing", "processed_at": datetime.now(timezone.utc).isoformat(),
    })
    if not claimed:
        print("[SKIP] Queue entry was already claimed or changed")
        return

    # 6. Run booking
    result = await book_tee_time_api(target_date, time_start, time_end, player_count)

    # 7. Update Supabase + send notification
    now_utc = datetime.now(timezone.utc).isoformat()

    if result["success"]:
        supabase_patch("booking_queue", {"id": f"eq.{booking_id}"}, {
            "status":       "booked",
            "processed_at": now_utc,
            "booked_time":  result["time"],
            "booked_ref":   result.get("ref") or "",
        })
        msg = f"Booked {target_date} at {result['time']}"
        if result.get("ref"):
            msg += f" (Ref: {result['ref']})"
        send_ntfy(msg, tags="white_check_mark,golf")
        print(f"\n[SUCCESS] {msg}")
        try:
            sync_booking(booking_id, target_date, result["time"], result.get("ref"))
        except Exception as exc:
            print(f"[CALENDAR] Sync failed ({type(exc).__name__}); booking is still confirmed")
    else:
        try:
            supabase_patch("booking_queue", {"id": f"eq.{booking_id}"}, {
                "status":         "failed",
                "processed_at":   now_utc,
                "failure_reason": result["error"],
            })
        except Exception as db_err:
            print(f"[WARN] Could not update queue status: {db_err}")
        msg = f"No booking confirmed for {target_date}: {result['error']}"
        send_ntfy(msg, title="Booking Failed", tags="x")
        print(f"\n[FAILED] {msg}")

    print("\n" + "=" * 60)
    print("Automation complete")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
