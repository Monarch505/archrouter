#!/usr/bin/env python3
"""Setup warp-b sing-box.json with the proven recipe:
IPv4-only allowed_ips, MTU 1420, reserved [0,0,0], hostname endpoint."""
import json

CONF = "/home/moria/.archrouter/warp/warp-b/wgcf-profile.conf"
OUT = "/home/moria/.archrouter/warp/warp-b/sing-box.json"

priv = pub = None
with open(CONF) as f:
    for line in f:
        s = line.strip()
        if s.startswith("PrivateKey"):
            priv = s.split("=", 1)[1].strip()
        elif s.startswith("PublicKey"):
            pub = s.split("=", 1)[1].strip()
assert priv and pub and len(priv) == 44 and len(pub) == 44, "bad keys"

cfg = {
    "log": {"level": "warning",
            "output": "/home/moria/.archrouter/warp/warp-b/sing-box.log"},
    "inbounds": [{"type": "socks", "tag": "socks-in",
                  "listen": "127.0.0.1", "listen_port": 11811}],
    "outbounds": [{"type": "direct", "tag": "direct"}],
    "endpoints": [{
        "type": "wireguard", "tag": "warp-ep",
        "address": ["172.16.0.2/32"],
        "private_key": priv,
        "peers": [{
            "address": "engage.cloudflareclient.com", "port": 2408,
            "public_key": pub,
            "allowed_ips": ["0.0.0.0/0"],
            "reserved": [0, 0, 0]
        }],
        "mtu": 1420
    }],
    "route": {"rules": [], "final": "warp-ep"}
}
with open(OUT, "w") as f:
    json.dump(cfg, f, indent=2)
print("warp-b config written")
