#!/bin/bash
# wg-native test: kernel WireGuard directly to WARP endpoint (no sing-box).
export PATH="$HOME/.archrouter/bin/x86_64:$HOME/.local/bin:$HOME/.local/node/bin:/usr/bin:/bin"
CONF="$HOME/.archrouter/warp/warp-a/wgcf-profile.conf"
PRIV=$(grep '^PrivateKey' "$CONF" | cut -d= -f2 | tr -d ' ')
PUB=$(grep '^PublicKey' "$CONF" | cut -d= -f2 | tr -d ' ')
echo "privlen=$(printf %s "$PRIV" | wc -c)"
sudo ip link del wg-test 2>/dev/null
sudo ip link add wg-test type wireguard && echo IF-OK
printf '%s' "$PRIV" > /tmp/wgpriv.key
chmod 600 /tmp/wgpriv.key
sudo wg set wg-test private-key /tmp/wgpriv.key peer "$PUB" endpoint 162.159.192.1:2408 allowed-ips 0.0.0.0/0 persistent-keepalive 25 && echo WG-SET-OK
rm -f /tmp/wgpriv.key
sudo ip addr add 172.16.0.2/32 dev wg-test
sudo ip link set wg-test up
sleep 12
echo "===WG-SHOW==="
sudo wg show wg-test
echo "===PING-VIA-WG==="
sudo ip route add 1.1.1.1/32 dev wg-test 2>/dev/null
ping -c2 -W6 1.1.1.1 2>&1 | tail -3
sudo ip route del 1.1.1.1/32 dev wg-test 2>/dev/null
sudo ip link del wg-test
echo WG-TEST-DONE
