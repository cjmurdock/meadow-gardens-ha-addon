#!/bin/bash
# Reads the add-on options, then runs the queue web app and the nightly scheduler.
set -euo pipefail
OPTS=/data/options.json
mkdir -p /data/state && chmod 700 /data /data/state

eval "$(python3 - "$OPTS" <<'PY'
import json, shlex, sys
o = json.load(open(sys.argv[1]))
# Values copied from a .env file often keep their quotes or a stray space.
o = {k: (v.strip().strip('"').strip("'").strip() if isinstance(v, str) else v) for k, v in o.items()}
env = {
    "SUPABASE_URL": o.get("supabase_url", ""),
    "SUPABASE_KEY": o.get("supabase_key", ""),
    "CHRONOGOLF_USER_ID": str(o.get("chronogolf_user_id") or ""),
    "NTFY_SERVER": o.get("ntfy_server") or "https://ntfy.sh",
    "NTFY_TOPIC": o.get("ntfy_topic", ""),
    "NTFY_TOKEN": o.get("ntfy_token") or "",
    "GOOGLE_CALENDAR_ID": o.get("google_calendar_id") or "",
    "GOOGLE_APPLICATION_CREDENTIALS": o.get("google_credentials_file") or "",
    "BOOKING_LIVE_ENABLED": "1" if o.get("booking_live_enabled") else "0",
    "LOGIN_CHECK_TIME_UTC": o.get("login_check_time_utc") or "01:30",
    "BOOKING_START_TIME_UTC": o.get("booking_start_time_utc") or "01:50",
}
for k, v in env.items():
    print(f"export {k}={shlex.quote(str(v))}")
PY
)"

# Only the Supervisor's ingress proxy can reach this port (no host ports are
# published), and the server trusts that proxy's address for sign-in.
export HOST=0.0.0.0 PORT=5001 INGRESS_TRUST=1
export CHRONOGOLF_COOKIES_FILE=/data/cookies.json BOOKING_STATE_DIR=/data/state BOOKING_PRIVATE_SCREENSHOTS=0
if [ ! -s /data/app_password ]; then
  python3 -c 'import secrets; print(secrets.token_urlsafe(32))' > /data/app_password
  chmod 600 /data/app_password
fi
export APP_PASSWORD="$(cat /data/app_password)"

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ]; then
  echo "[SETUP] Fill in supabase_url and supabase_key on the Configuration tab, then restart." >&2
  sleep 3600; exit 1
fi
echo "[START] Live booking: $([ "$BOOKING_LIVE_ENABLED" = 1 ] && echo ON || echo OFF)"

cd /opt/meadow/app && node dist/index.cjs &
WEB=$!
cd /opt/meadow && python3 scheduler.py &
SCHED=$!
# If either process stops, exit so the Supervisor watchdog restarts the add-on.
wait -n "$WEB" "$SCHED"
code=$?
kill "$WEB" "$SCHED" 2>/dev/null || true
exit "$code"
