"""Can this network host REEP? A pre-hosting check, standard library only.

Run it on the machine that will be the server, plugged into the network it
will be served from. It makes NO AWS call and needs NO credentials: it only
asks whether the network lets the server reach what REEP depends on, and
whether people can reach the server.

    python tools/lan/lan_check.py               # outbound: AWS, Google, clock
    python tools/lan/lan_check.py --serve 8080  # inbound: open from other devices

Exit status is 1 when any outbound check fails, so it can gate a script.
"""

from __future__ import annotations

import argparse
import email.utils
import http.server
import ipaddress
import os
import socket
import ssl
import sys
import time
import urllib.request

# What the API process talks to. Nova Sonic is in Tokyo (novaSonicRegion in
# infra/cdk/reep_core/stack.py); everything else is ap-south-1.
TARGETS = [
    ("sts.ap-south-1.amazonaws.com", "AWS credentials (STS)"),
    ("secretsmanager.ap-south-1.amazonaws.com", "Secrets Manager"),
    ("ssm.ap-south-1.amazonaws.com", "SSM parameters"),
    ("email.ap-south-1.amazonaws.com", "SES mail"),
    ("s3.ap-south-1.amazonaws.com", "S3 backups and archives"),
    ("bedrock-runtime.ap-south-1.amazonaws.com", "Bedrock (text)"),
    ("bedrock-runtime.ap-northeast-1.amazonaws.com", "Bedrock Nova Sonic (interview)"),
    ("accounts.google.com", "Google sign-in"),
    ("oauth2.googleapis.com", "Google token exchange"),
    ("www.googleapis.com", "Google signing keys"),
    ("sentry.io", "Sentry error reports"),
]

# SigV4 refuses a request whose clock is off by more than five minutes.
MAX_SKEW_SECONDS = 300
CGNAT = ipaddress.ip_network("100.64.0.0/10")


def check_tls(host: str) -> tuple[bool, str]:
    started = time.perf_counter()
    try:
        addr = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)[0][4][0]
    except OSError as exc:
        return False, f"DNS failed ({exc})"
    try:
        with socket.create_connection((host, 443), timeout=8) as raw:
            with ssl.create_default_context().wrap_socket(raw, server_hostname=host):
                pass
    except ssl.SSLCertVerificationError as exc:
        # A firewall that re-signs HTTPS breaks every AWS SDK call on the box.
        return False, f"TLS certificate rejected: the network may intercept HTTPS ({exc.verify_message})"
    except OSError as exc:
        return False, f"blocked or unreachable on 443 ({exc})"
    return True, f"{(time.perf_counter() - started) * 1000:.0f} ms via {addr}"


def local_address() -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect(("1.1.1.1", 80))  # chooses the outbound interface, sends nothing
        return s.getsockname()[0]


def public_address_and_skew() -> tuple[str, float | None]:
    with urllib.request.urlopen("https://checkip.amazonaws.com", timeout=8) as reply:
        ip = reply.read().decode().strip()
        date = reply.headers.get("Date")
    skew = None
    if date:
        skew = time.time() - email.utils.parsedate_to_datetime(date).timestamp()
    return ip, skew


def outbound() -> int:
    failures = 0
    proxy = [k for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy") if os.environ.get(k)]
    if proxy:
        print(f"note  a proxy is configured ({', '.join(proxy)}); the AWS SDK will use it too\n")

    print("Outbound HTTPS (port 443)")
    for host, purpose in TARGETS:
        ok, detail = check_tls(host)
        failures += not ok
        print(f"  {'PASS' if ok else 'FAIL'}  {purpose:<32} {host}  {detail}")

    print("\nAddresses and clock")
    try:
        lan = local_address()
        print(f"  info  LAN address     {lan}")
    except OSError as exc:
        lan = ""
        print(f"  FAIL  LAN address     no route out ({exc})")
        failures += 1
    try:
        public, skew = public_address_and_skew()
        print(f"  info  public address  {public}")
        if ipaddress.ip_address(public) in CGNAT:
            print("  FAIL  public address is carrier-grade NAT: nothing outside can reach this server")
            failures += 1
        if skew is None:
            print("  warn  clock skew unknown")
        elif abs(skew) > MAX_SKEW_SECONDS:
            print(f"  FAIL  clock is {skew:+.0f} s off; AWS will refuse every signed request")
            failures += 1
        else:
            print(f"  PASS  clock skew {skew:+.1f} s")
    except OSError as exc:
        print(f"  FAIL  public address  could not ask checkip.amazonaws.com ({exc})")
        failures += 1

    print("\nInbound is not tested here: run with --serve and open it from other devices.")
    print(f"{failures} check(s) failed." if failures else "All outbound checks passed.")
    return 1 if failures else 0


PAGE = b"""<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width">
<title>REEP LAN check</title><body style="font:16px system-ui;margin:16px">
<h1>REEP LAN check</h1><p id=ip></p><button id=go>Measure speed</button><pre id=out></pre>
<script>
fetch('whoami').then(r=>r.text()).then(t=>ip.textContent='Reached the server. It sees you as '+t);
go.onclick=async()=>{const mb=5,b=mb*8;out.textContent='measuring...';
let t=performance.now();await (await fetch('blob?mb='+mb)).arrayBuffer();
const down=b/((performance.now()-t)/1000);
t=performance.now();await fetch('upload',{method:'POST',body:new Uint8Array(mb*1048576)});
const up=b/((performance.now()-t)/1000);
out.textContent='download '+down.toFixed(1)+' Mbit/s\\nupload   '+up.toFixed(1)+
' Mbit/s\\n\\nA 5 MB CV needs about '+(b/up).toFixed(1)+' s to upload.\\n'+
'A live interview streams about 0.4 Mbit/s each way per student.';};
</script>"""


class Probe(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path.startswith("/whoami"):
            return self._send(self.client_address[0].encode(), "text/plain")
        if self.path.startswith("/blob"):
            mb = min(int(self.path.partition("mb=")[2] or 5), 50)
            self.send_response(200)
            self.send_header("Content-Length", str(mb * 1048576))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            chunk = b"\0" * 65536
            for _ in range(mb * 16):
                self.wfile.write(chunk)
            return None
        return self._send(PAGE, "text/html")

    def do_POST(self) -> None:
        remaining = int(self.headers.get("Content-Length", 0))
        while remaining:
            remaining -= len(self.rfile.read(min(remaining, 65536)))
        self._send(b"ok", "text/plain")

    def _send(self, body: bytes, kind: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        print(f"  request from {self.client_address[0]}: {fmt % args}")


def serve(port: int) -> int:
    try:
        lan = local_address()
    except OSError:
        lan = "<this machine's address>"
    print(f"Serving on port {port}. Open on another device:")
    print(f"  same network:   http://{lan}:{port}/")
    print(f"  from outside:   http://<public address>:{port}/  (phone on mobile data, Wi-Fi off)")
    print("A request that never shows up below was blocked before it reached this machine.")
    print("Ctrl+C to stop.\n")
    try:
        http.server.ThreadingHTTPServer(("0.0.0.0", port), Probe).serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--serve", type=int, metavar="PORT", help="serve the inbound/speed test page")
    args = parser.parse_args()
    return serve(args.serve) if args.serve else outbound()


if __name__ == "__main__":
    sys.exit(main())
