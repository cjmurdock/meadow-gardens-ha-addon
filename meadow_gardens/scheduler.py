#!/usr/bin/env python3
"""Runs the login check and the booking worker once a day at fixed UTC times.

Same behaviour as the systemd timers it replaces: a missed time is not
caught up later, and a run never starts while another is still going.
"""
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from datetime import datetime, timedelta, timezone

WORKER_DIR = "/opt/meadow/worker"
GRACE = timedelta(minutes=2)  # start a run at most 2 min late, else skip it


def parse(hhmm):
    h, m = hhmm.split(":")
    return int(h), int(m)


JOBS = [
    ("login check", parse(os.environ.get("LOGIN_CHECK_TIME_UTC", "01:30")),
     ["check_login.py", "--notify"], 2 * 60),
    ("booking", parse(os.environ.get("BOOKING_START_TIME_UTC", "01:50")),
     ["book_api.py"], 25 * 60),
]


def next_run(now, hm):
    t = now.replace(hour=hm[0], minute=hm[1], second=0, microsecond=0)
    return t if t > now else t + timedelta(days=1)


LOG_DIR = Path(os.environ.get("BOOKING_STATE_DIR", "/data/state")) / "logs"
KEEP_DAYS = 30
BC = timezone(timedelta(hours=-7))


def stamp():
    """B.C. time to the millisecond: the 7:00:01 race needs exact timing."""
    return datetime.now(BC).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def write(line):
    """Print to the add-on log and append to a daily file in /data/state/logs."""
    print(line, flush=True)
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_DIR / f"{datetime.now(BC):%Y-%m-%d}.log", "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def prune_logs():
    cutoff = time.time() - KEEP_DAYS * 86400
    for f in LOG_DIR.glob("*.log"):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
        except OSError:
            pass


def log(msg):
    write(f"{stamp()} [scheduler] {msg}")


def run(name, args, timeout):
    log(f"starting {name}")
    tag = "login" if "check_login" in args[0] else "booking"
    start = time.monotonic()
    proc = subprocess.Popen([sys.executable, "-u", *args], cwd=WORKER_DIR, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1)
    timer = threading.Timer(timeout, proc.kill)
    timer.start()
    try:
        for line in proc.stdout:
            write(f"{stamp()} [{tag}] {line.rstrip()}")
        proc.wait()
    finally:
        timer.cancel()
    if time.monotonic() - start >= timeout:
        log(f"{name} stopped after {timeout // 60} min timeout")
    else:
        log(f"{name} finished with exit code {proc.returncode}")
    prune_logs()


def main():
    now = datetime.now(timezone.utc)
    schedule = {name: next_run(now, hm) for name, hm, _, _ in JOBS}
    for name, when in schedule.items():
        log(f"next {name}: {when:%Y-%m-%d %H:%M} UTC ({(when - timedelta(hours=7)):%H:%M} B.C.)")
    while True:
        now = datetime.now(timezone.utc)
        for name, hm, args, timeout in JOBS:
            when = schedule[name]
            if now >= when:
                if now - when <= GRACE:
                    run(name, args, timeout)
                else:
                    log(f"skipped {name}: {when:%H:%M} UTC passed while the add-on was busy or down")
                schedule[name] = next_run(datetime.now(timezone.utc), hm)
                log(f"next {name}: {schedule[name]:%Y-%m-%d %H:%M} UTC")
        time.sleep(0.5)


if __name__ == "__main__":
    main()
