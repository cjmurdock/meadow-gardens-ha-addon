#!/usr/bin/env python3
"""Pre-booking health check. Never freezes or reserves tee times.

1. Loads the Chronogolf dashboard with the saved session.
2. Makes one read-only tee-time listing request (the same endpoint the
   booking worker uses at 7 PM) for an already-released date, so an API
   block (401/403/429 or a Cloudflare challenge) shows up before booking.
"""
import asyncio
import sys
from datetime import datetime, timedelta, timezone

from book_api import (BC_TIMEZONE, COURSE_ID, JS_GET_TEETIMES, MEMBER_GUEST_ID,
                      MEMBER_TYPE_ID, pause_for_session, send_ntfy, supabase_patch)
from session import SessionRequired, open_dashboard

ADVANCE_DAYS = 10


async def probe_listing(page, date_str, label=""):
    result = await page.evaluate(JS_GET_TEETIMES, {
        "date": date_str, "courseId": COURSE_ID, "memberTypeId": MEMBER_TYPE_ID,
        "guestTypeId": MEMBER_GUEST_ID, "maxRetries": 1, "retryMs": 0,
    })
    if result.get("accessBlocked"):
        raise SessionRequired("Chronogolf tee-time listing was blocked (401/403/429 or verification); "
                              "the dashboard loaded but the booking API refused this session")
    slots = result.get("teetimes") or []
    times = sorted(t.get("start_time", "") for t in slots if isinstance(t, dict))
    span = f"{times[0]}–{times[-1]}" if times else "none"
    print(f"[CHECK] Tee-time listing for {date_str}{label}: HTTP OK, {len(slots)} slots ({span}). Nothing was booked.")


async def main(notify, probe_date):
    from playwright.async_api import async_playwright
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            try:
                context = await browser.new_context(timezone_id="Etc/GMT+7", locale="en-CA")
                page = await open_dashboard(context)
                print("[CHECK] Dashboard reached.")
                await probe_listing(page, probe_date)
                # Tonight's target date: normally empty until the 7 PM release.
                target = (datetime.now(BC_TIMEZONE) + timedelta(days=ADVANCE_DAYS)).strftime("%Y-%m-%d")
                await probe_listing(page, target, " (tonight's target, normally empty before 7 PM)")
            finally:
                await browser.close()
        if notify:
            now = datetime.now(timezone.utc).isoformat()
            supabase_patch("session_state", {"id": "eq.1"}, {
                "is_healthy": True, "last_login": now, "updated_at": now,
            })
        return 0
    except SessionRequired as exc:
        print(f"[CHECK] {exc}")
        if notify:
            pause_for_session(str(exc))
            send_ntfy(str(exc), title="Booking paused: manual sign-in required", priority="urgent", tags="warning,key")
    except Exception as exc:
        print(f"[CHECK] Browser/network/database error: {type(exc).__name__}: {exc}")
        if notify:
            send_ntfy("Login check could not complete. See private worker logs.", title="Booking login check failed", tags="warning")
    return 1


if __name__ == "__main__":
    tomorrow = (datetime.now(BC_TIMEZONE) + timedelta(days=1)).strftime("%Y-%m-%d")
    dates = [a.split("=", 1)[1] for a in sys.argv if a.startswith("--date=")]
    sys.exit(asyncio.run(main("--notify" in sys.argv, dates[0] if dates else tomorrow)))
