#!/usr/bin/env python3
"""Dashboard-only health check. Never lists, freezes, or reserves tee times."""
import asyncio
import sys
from datetime import datetime, timezone

from book_api import pause_for_session, send_ntfy, supabase_patch
from session import SessionRequired, open_dashboard


async def main(notify):
    from playwright.async_api import async_playwright
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            try:
                context = await browser.new_context(timezone_id="Etc/GMT+7", locale="en-CA")
                await open_dashboard(context)
            finally:
                await browser.close()
        print("[CHECK] Dashboard reached. Nothing was booked.")
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
        print(f"[CHECK] Browser/network/database error: {type(exc).__name__}")
        if notify:
            send_ntfy("Login check could not complete. See private worker logs.", title="Booking login check failed", tags="warning")
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main("--notify" in sys.argv)))
