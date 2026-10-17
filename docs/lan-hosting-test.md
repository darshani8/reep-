# Can this network host REEP? (pre-hosting test)

Run this before buying an on-site server. A laptop on the same network stands
in for the server. AWS keeps everything it holds today: SES, Bedrock, Secrets
Manager, backups. **Production stays on AWS and its traffic is not touched.**
Every step here uses the dev seed, never real student data.

## Stage 1: can the server reach what REEP depends on

```
python tools/lan/lan_check.py
```

Run it on the laptop, plugged into the network you are testing (the same port
or Wi-Fi the server would use). It needs no AWS credentials. It checks DNS and
a verified HTTPS handshake to every AWS and Google endpoint the API calls, the
public address, and the clock.

| Result | Meaning | Fix |
|---|---|---|
| `blocked or unreachable on 443` | The firewall blocks that host | Ask IT to allow outbound 443 to `*.amazonaws.com`, `*.google.com`, `*.googleapis.com` and `sentry.io` |
| `TLS certificate rejected` | The firewall intercepts and re-signs HTTPS | Ask IT to exempt the server from SSL inspection. Trusting their CA works too, but the AWS SDK and Python both need it |
| `carrier-grade NAT` | The connection has no public address of its own | No inbound hosting is possible on this line. Get a static public IP from the ISP, or use a tunnel (stage 2) |
| `clock is ... off` | AWS refuses signed requests | Turn on automatic time sync (NTP) |

## Stage 2: can people reach the server

```
python tools/lan/lan_check.py --serve 8080
```

Open the printed address from:

1. **Another device on the same network**, e.g. a phone on campus Wi-Fi. If
   it never loads and no request appears in the terminal, either Wi-Fi client
   isolation is on or the laptop's firewall is blocking it. On Windows, allow
   Python on *Private* networks when asked.
2. **A phone on mobile data with Wi-Fi off**, at `http://<public address>:8080/`.
   This only works after IT forwards a port on the router to the laptop. If
   it fails, the network cannot serve the internet directly. The usual answer
   is a tunnel (Cloudflare Tunnel needs no inbound port at all), with the
   real server later.

Press **Measure speed** on each device. One live mock interview streams about
0.4 Mbit/s each way per student, so multiply by how many students practise at
once. The page also shows how long a 5 MB CV takes to upload.

## Stage 3: the real app, end to end

Stages 1 and 2 cannot see a firewall that kills long-lived connections. A
mock interview holds one WebSocket open for up to 8 minutes, plus a Bedrock
stream to Tokyo for the same time.

1. Run the stack as `AGENTS.md` "Running it" describes: local Postgres, the
   dev seed, `ENV=dev`. Bind both servers to the LAN:
   `uvicorn app.main:app --host 0.0.0.0 --port 3300` and
   `npx ng serve --host 0.0.0.0`.
2. Give the laptop AWS access through a named profile (`aws configure sso` or
   `AWS_PROFILE`), never a key pasted into `.env`. A test IAM user or role
   needs only `bedrock:InvokeModelWithBidirectionalStream` and
   `bedrock:InvokeModel` (plus `ses:SendEmail` if you set `SES_FROM_ADDRESS`).
   No production secret is needed, and `AUTH_SECRET` should be a fresh
   value, not production's.
3. **The microphone needs HTTPS.** Browsers only allow microphone access on
   `https://` or `localhost`, so on `http://192.168.x.x` the interview cannot
   start, and that is not a network fault. Put the test behind HTTPS: a
   tunnel gives you that, or use a locally trusted certificate (`mkcert`)
   on the LAN. Do the same for Google sign-in, whose redirect URI must be
   HTTPS and registered for that hostname (`docs/google-sign-in.md`).
4. From another device, sign in as `student@bgscet.ac.in` and do one full
   interview to the scorecard. Then upload a CV on Skilling. If the voice
   cuts out at the same minute every time, a firewall idle or session
   timeout is the cause, not the app.

## `test.sast-skills.com` through a Cloudflare Tunnel (no AWS changes)

`sast-skills.com`'s DNS is on Cloudflare (nameservers `*.ns.cloudflare.com`),
so the test hostname is a Cloudflare record, not a Route 53 one. Nothing in
AWS is created, edited or deployed: production's CloudFront, ALB, WAF, RDS
and SES identity are untouched. Do not edit the DKIM or other existing
records in the Cloudflare zone, because SES mail depends on them. The tunnel
also provides the HTTPS the microphone and Google sign-in need.

A tunnel connects OUTBOUND from the laptop. It therefore proves the network
and the app work, but says nothing about whether the network accepts inbound
connections. Stage 2 is still the test for that, if the real server will not
sit behind a tunnel too.

On the laptop (PowerShell):

```
winget install --id Cloudflare.cloudflared
cloudflared tunnel login                 # browser: pick sast-skills.com
cloudflared tunnel create reep-test      # prints the tunnel id
cloudflared tunnel route dns reep-test test.sast-skills.com
```

`%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: reep-test
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: test.sast-skills.com
    service: http://localhost:4200
    originRequest:
      httpHostHeader: localhost:4200   # ng serve refuses unknown Host headers
  - service: http_status:404
```

Everything goes to `ng serve`, whose `proxy.conf.json` already forwards `/api`
(WebSockets included) to the API on 3300. The page and the API therefore
share one origin and the session cookie is carried.

`apps/api-py/.env` for the test:

```
ENV=dev                                  # dev seed only, never real students
WEB_ORIGIN=https://test.sast-skills.com  # CORS, interview Origin check, emailed links
AWS_PROFILE=<your existing profile>      # existing access; no new IAM user
INTERVIEW_ENGINE=nova
NOVA_SONIC_REGION=ap-northeast-1
# SES_FROM_ADDRESS=no-reply@sast-skills.com   # only when testing mail, and
#   only to your own address: the seeded accounts are @bgscet.ac.in
```

Then run the API and `npx ng serve`, and `cloudflared tunnel run reep-test`
(or let `tools\lan\start-test-tunnel.ps1` do every step above, and
`-Remove` undo them).
Sign in at `https://test.sast-skills.com` as `student@bgscet.ac.in` /
`student123` and run stage 3. When finished, stop `cloudflared` (the hostname
then shows a Cloudflare error page) and `cloudflared tunnel delete reep-test`,
then remove the `test` CNAME in the Cloudflare dashboard.

## What passing means for the real server

All three stages passing on the laptop means the network is fine. The real
server still needs its own Postgres with backups, file storage for uploads, a
static IP or tunnel, and a UPS. Those are hardware questions this test does
not answer.
