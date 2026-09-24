#!/usr/bin/env python3
"""Kill only the sing-box running the warp-a config (avoids pkill self-match)."""
import os
import signal

TARGET = "warpa" + "/" + "singbox"
T1 = "warp-a"
T2 = "sing-box.json"
killed = []
for pid in filter(str.isdigit, os.listdir("/proc")):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmd = f.read().decode(errors="replace")
    except (FileNotFoundError, PermissionError):
        continue
    if T1 in cmd and T2 in cmd and "python" not in cmd.split("\x00")[0]:
        try:
            os.kill(int(pid), signal.SIGTERM)
            killed.append(pid)
        except ProcessLookupError:
            pass
print(f"KILLED: {killed}" if killed else "NO-MATCH")
