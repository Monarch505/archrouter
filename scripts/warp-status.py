#!/usr/bin/env python3
"""Quick status: warp-a/b handshake health + public IPs + pool API."""
import json
import subprocess
import urllib.request

BASE = "/home/moria/.archrouter/warp"


def hs_fail(path):
    try:
        with open(path, errors="replace") as f:
            return sum(1 for ln in f if "handshake did not" in ln)
    except FileNotFoundError:
        return -1


for inst in ("warp-a", "warp-b"):
    print(f"{inst}: hs_fail={hs_fail(f'{BASE}/{inst}/sing-box.log')}",
          flush=True)

for name, port in (("warp-a", 11810), ("warp-b", 11811), ("pool", 11801)):
    try:
        out = subprocess.run(
            ["curl", "-s", "--max-time", "15", "--socks5-hostname",
             f"127.0.0.1:{port}", "https://api.ipify.org"],
            capture_output=True, text=True, timeout=25)
        print(f"{name}({port}): ip={out.stdout.strip()} exit={out.returncode}",
              flush=True)
    except Exception as e:
        print(f"{name}({port}): ERR {e}", flush=True)

try:
    with urllib.request.urlopen("http://127.0.0.1:9190/",
                                timeout=10) as r:
        print("pool-api:", r.read().decode()[:400], flush=True)
except Exception as e:
    print(f"pool-api: ERR {e}", flush=True)
