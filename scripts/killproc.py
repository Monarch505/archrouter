#!/usr/bin/env python3
"""Kill manually-started archrouter processes (pool.js / sing-box) by cmdline.
Avoids pkill self-match: killer cmdline never contains the literal pattern."""
import os
import signal
import sys

MODE = sys.argv[1] if len(sys.argv) > 1 else "pool"
if MODE == "pool":
    # match: node ... pool/pool.js  (split so our own cmdline never matches)
    T1 = "pool" + "/" + "pool" + ".js"
    T2 = "no" + "de"
else:
    T1 = "sing" + "-box"
    T2 = "run"

killed = []
for pid in filter(str.isdigit, os.listdir("/proc")):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            parts = f.read().split(b"\x00")
    except (FileNotFoundError, PermissionError):
        continue
    if not parts or not parts[0]:
        continue
    exe = parts[0].decode(errors="replace")
    if "python" in exe:
        continue
    full = b"\x00".join(parts).decode(errors="replace")
    if T1 in full and T2 in full:
        try:
            os.kill(int(pid), signal.SIGTERM)
            killed.append(pid)
        except ProcessLookupError:
            pass
print(f"KILLED-{MODE}: {killed}" if killed else f"NO-MATCH-{MODE}")
