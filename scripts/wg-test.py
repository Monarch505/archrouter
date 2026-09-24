#!/usr/bin/env python3
"""wg-native test: kernel WireGuard directly to WARP endpoint (no sing-box)."""
import subprocess
import time
import sys

CONF = "/home/moria/.archrouter/warp/warp-a/wgcf-profile.conf"
ENDPOINT = "162.159.192.1:2408"


def sh(*args, check=False):
    r = subprocess.run(args, capture_output=True, text=True)
    if check and r.returncode != 0:
        print(f"FAIL {' '.join(args)}: {r.stderr.strip()}", flush=True)
        sys.exit(1)
    return r


priv = pub = None
with open(CONF) as f:
    for line in f:
        s = line.strip()
        if s.startswith("PrivateKey"):
            priv = s.split("=", 1)[1].strip()
        elif s.startswith("PublicKey"):
            pub = s.split("=", 1)[1].strip()
print(f"privlen={len(priv or '')} publen={len(pub or '')}", flush=True)
assert priv and pub and len(priv) == 44 and len(pub) == 44, "bad keys"

sh("sudo", "ip", "link", "del", "wg-test")
sh("sudo", "ip", "link", "add", "wg-test", "type", "wireguard", check=True)
print("IF-OK", flush=True)
with open("/tmp/wgpriv.key", "w") as f:
    f.write(priv)
sh("sudo", "chmod", "600", "/tmp/wgpriv.key", check=True)
r = sh("sudo", "wg", "set", "wg-test", "private-key", "/tmp/wgpriv.key",
       "peer", pub, "endpoint", ENDPOINT, "allowed-ips", "0.0.0.0/0",
       "persistent-keepalive", "25")
sh("sudo", "rm", "-f", "/tmp/wgpriv.key")
if r.returncode != 0:
    print(f"WG-SET-FAIL: {r.stderr.strip()}", flush=True)
    sys.exit(1)
print("WG-SET-OK", flush=True)
sh("sudo", "ip", "addr", "add", "172.16.0.2/32", "dev", "wg-test", check=True)
sh("sudo", "ip", "link", "set", "wg-test", "up", check=True)
time.sleep(14)
print("===WG-SHOW===", flush=True)
print(sh("sudo", "wg", "show", "wg-test").stdout, flush=True)
print("===PING-VIA-WG===", flush=True)
sh("sudo", "ip", "route", "add", "1.1.1.1/32", "dev", "wg-test")
print(sh("ping", "-c2", "-W6", "1.1.1.1").stdout.strip().splitlines()[-2:], flush=True)
sh("sudo", "ip", "link", "del", "wg-test")
print("WG-TEST-DONE", flush=True)
