"""Independent Google Calendar integration; retries do not rebook tee times."""
import os
import sys
from datetime import datetime, timedelta, timezone
from uuid import NAMESPACE_URL, uuid5
from urllib.parse import quote


def event_body(booking_id, day, time_label, reference):
    start = datetime.strptime(f"{day} {time_label}", "%Y-%m-%d %I:%M %p")
    start = start.replace(tzinfo=timezone(timedelta(hours=-7)))
    return {
        "id": uuid5(NAMESPACE_URL, f"meadow-gardens:{booking_id}").hex,
        "summary": "Golf at Meadow Gardens",
        "location": "Meadow Gardens Golf Club",
        "description": f"Booking reference: {reference}" if reference else "Booked tee time.",
        "start": {"dateTime": start.isoformat()},
        "end": {"dateTime": (start + timedelta(hours=4)).isoformat()},
    }


def sync_booking(booking_id, day, time_label, reference):
    calendar_id = os.environ.get("GOOGLE_CALENDAR_ID")
    credentials_file = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not calendar_id and not credentials_file:
        print("[CALENDAR] Not configured")
        return
    if not calendar_id or not credentials_file:
        raise ValueError("Both Calendar variables must be set")
    from google.oauth2.service_account import Credentials
    from google.auth.transport.requests import AuthorizedSession
    creds = Credentials.from_service_account_file(
        credentials_file, scopes=["https://www.googleapis.com/auth/calendar.events"]
    )
    events = f"https://www.googleapis.com/calendar/v3/calendars/{quote(calendar_id, safe='')}/events"
    body = event_body(booking_id, day, time_label, reference)
    with AuthorizedSession(creds) as client:
        response = client.post(events, json=body, timeout=20)
        if response.status_code == 409:
            client.get(f"{events}/{body['id']}", timeout=20).raise_for_status()
        else:
            response.raise_for_status()
    print("[CALENDAR] Event present")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: calendar_sync.py BOOKED_QUEUE_UUID")
    from uuid import UUID
    from book_api import supabase_get
    row_id = str(UUID(sys.argv[1]))
    rows = supabase_get("booking_queue", {"id": f"eq.{row_id}", "status": "eq.booked"})
    if not rows:
        sys.exit("No confirmed queue row found")
    row = rows[0]
    sync_booking(row_id, row["play_date"], row["booked_time"], row.get("booked_ref"))
