# Meadow Gardens Tee Times

Books queued Meadow Gardens tee times on Chronogolf at 7:00 PM B.C. time, ten days ahead.

## Schedule (B.C. time, fixed UTC-7)
- 6:30 PM: login check (alerts you through ntfy if the session needs renewing)
- 6:50 PM: booking worker starts; it lists tee times from 7:00:01 PM

A missed time is not caught up later. Avoid restarting the add-on or updating Home Assistant between 6:45 and 7:15 PM.

## Setup
1. Fill in the Configuration tab: Supabase URL and server-side key, Chronogolf user ID, ntfy topic.
2. Open **Tee Times** in the sidebar, go to **Settings**, and paste your Chronogolf session: the `cookie:` request header from Chrome DevTools (Network tab, any chronogolf.com request) or a JSON cookie export.
3. Leave **booking_live_enabled** off until the login check passes and any other booking automation is paused. Two workers must never book the same date.

## Google Calendar (optional)
Copy the service-account JSON to `/share/meadow-gardens/google-calendar.json`, then set `google_credentials_file` to that path and `google_calendar_id` to the calendar ID.

## Privacy
The session file and settings live in this add-on's private data folder, which is included in Home Assistant backups. Keep backups password-protected.
