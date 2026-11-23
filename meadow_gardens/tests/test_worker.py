import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
import book_api as b
from calendar_sync import event_body
from session import normalize_cookies


class WorkerTests(unittest.TestCase):
    def test_session_excludes_clearance_and_unrelated_cookies(self):
        def cookie(name, domain=".chronogolf.com", **kw):
            return dict(name=name, domain=domain, value="synthetic", **kw)
        raw = {"cookies": [
            cookie("session"), cookie("cf_clearance"), cookie("__cf_bm"),
            cookie("other", "example.invalid"), cookie("expired", expires=1234), None,
        ]}
        self.assertEqual([x["name"] for x in normalize_cookies(raw)], ["session"])

    def test_calendar_timestamp_and_idempotent_key(self):
        event = event_body("fixture-uuid", "2026-12-04", "11:45 PM", "TEST")
        self.assertEqual(event["start"]["dateTime"], "2026-12-04T23:45:00-07:00")
        self.assertEqual(event["end"]["dateTime"], "2026-12-05T03:45:00-07:00")
        self.assertEqual(event["id"], event_body("fixture-uuid", "2026-12-04", "11:45 PM", None)["id"])

    @patch.multiple(b, SUPABASE_URL="http://localhost", SUPABASE_KEY="synthetic", USER_ID=123)
    def test_disabled_worker_does_not_contact_database(self):
        with patch.dict(os.environ, {"BOOKING_LIVE_ENABLED": "0", "CHRONOGOLF_COOKIES_FILE": "/unused"}), \
                patch.object(b, "supabase_get") as get, patch.object(b, "book_tee_time_api") as run:
            asyncio.run(b.main())
        get.assert_not_called()
        run.assert_not_called()

    @patch.multiple(b, SUPABASE_URL="http://localhost", SUPABASE_KEY="synthetic", USER_ID=123)
    def test_empty_queue_is_quiet(self):
        with patch.dict(os.environ, {"BOOKING_LIVE_ENABLED": "1", "CHRONOGOLF_COOKIES_FILE": "/unused"}), \
                patch.object(b, "supabase_get", side_effect=[[], [], []]), \
                patch.object(b, "send_ntfy") as alert, patch.object(b, "book_tee_time_api") as run:
            asyncio.run(b.main())
        alert.assert_not_called()
        run.assert_not_called()

    @patch.multiple(b, SUPABASE_URL="http://localhost", SUPABASE_KEY="synthetic", USER_ID=123)
    def test_claim_and_confirm_with_mock_booking(self):
        fixture = {"id": "fake-id", "time_window_start": "10:00", "time_window_end": "14:00", "player_count": 2}
        run = AsyncMock(return_value={"success": True, "time": "10:00 AM", "ref": "TEST"})
        writes = Mock(side_effect=[[fixture], [fixture]])
        with patch.dict(os.environ, {"BOOKING_LIVE_ENABLED": "1", "CHRONOGOLF_COOKIES_FILE": "/unused"}), \
                patch.object(b, "supabase_get", side_effect=[[{"is_paused": False}], [{"value": "10"}], [fixture]]) as get, \
                patch.object(b, "supabase_patch", writes), patch.object(b, "book_tee_time_api", run), \
                patch.object(b, "send_ntfy") as notify, patch.object(b, "sync_booking") as calendar:
            asyncio.run(b.main())
        target = get.call_args.args[1]["play_date"].removeprefix("eq.")
        run.assert_awaited_once_with(target, "10:00", "14:00", 2)
        self.assertEqual(writes.call_args_list[0].args[1]["status"], "eq.pending")
        self.assertEqual(writes.call_args_list[1].args[2]["status"], "booked")
        notify.assert_called_once()
        calendar.assert_called_once_with("fake-id", target, "10:00 AM", "TEST")


if __name__ == "__main__":
    unittest.main()
