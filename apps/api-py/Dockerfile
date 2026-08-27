# REEP API — FastAPI on Python 3.14.
#
# Separate from the voice worker on purpose. The two share almost no
# dependencies (API ~370 MB, dominated by litellm and google-adk; worker ~505 MB,
# dominated by livekit and onnxruntime), they scale differently, and merging them
# would ship ~800 MB of site-packages to both a stateless web pod and a
# long-lived audio pod.
#
# glibc base, not Alpine: psycopg has musl wheels but the shared toolchain and
# ca-certificates story is simpler here, and libpq — unlike the worker's TLS —
# has no certifi fallback to lean on.

FROM python:3.14-slim-bookworm

# PYTHONUNBUFFERED so logs reach the orchestrator immediately rather than
# sitting in a pipe buffer during an incident.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencies first so a code change does not invalidate the pip layer.
COPY requirements.txt ./
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY app ./app
COPY migrations ./migrations
COPY alembic.ini ./

# Non-root. The API writes nothing to disk except uploads, which belong on a
# mounted volume or object storage rather than the container filesystem.
RUN groupadd --gid 10001 reep \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin reep \
 && mkdir -p /var/reep/uploads \
 && chown -R 10001:10001 /app /var/reep
USER 10001:10001

# UPLOAD_DIR must be a MOUNTED volume in production. Left blank, config.py
# resolves to /app/var/uploads INSIDE the container layer, so every redeploy
# silently destroys student uploads. This ENV only relocates it somewhere
# mountable — it is not a substitute for actually mounting it.
ENV UPLOAD_DIR=/var/reep/uploads

EXPOSE 3300

# --host 0.0.0.0 is REQUIRED in a container. Locally uvicorn is started with
# only --port, so it binds 127.0.0.1 and is unreachable from outside the
# network namespace — the container would look healthy and refuse every request.
#
# Migrations are deliberately NOT run here: this entrypoint runs in every
# replica, and concurrent `alembic upgrade head` across replicas races on the
# version table. Run them once, as a separate job/init container.
#   --host 0.0.0.0            uvicorn defaults to 127.0.0.1, which in a container
#                             binds the container's own loopback and refuses
#                             every probe while looking perfectly healthy.
#   --proxy-headers           behind a TLS-terminating ingress, so the app sees
#                             the real scheme/client rather than the proxy's.
#                             WHICH peers to believe comes from the
#                             FORWARDED_ALLOW_IPS env var below — uvicorn reads
#                             it natively when the CLI flag is absent. It was
#                             "*", and "*" is not a default, it is a decision:
#                             trusting X-Forwarded-For from ANY peer lets a
#                             client prepend fake entries and pick its own
#                             request.client.host — which is the key the
#                             registration rate limiter buckets by, so one
#                             machine rotating a header gets an unlimited
#                             budget on the app's only unauthenticated write.
#                             The default is this deployment's VPC
#                             (infra/aws/network.tf cidr_block): every real
#                             proxy hop — ALB, the nginx `web` container — is
#                             inside it, every client is not, so uvicorn
#                             resolves the rightmost address a proxy actually
#                             appended and ignores whatever the client typed.
#                             Override per environment; never set it back to *.
#   --timeout-graceful-shutdown 110
#                             strictly BELOW the 120s stop_grace_period, so
#                             uvicorn finishes draining before SIGKILL. This
#                             matters for /api/agent/chat/stream, which persists
#                             the assistant turn only after the last delta — a
#                             hard kill mid-stream loses the turn.
# NEVER --reload (AGENTS.md: it wedges a stale worker on this platform).
ENV FORWARDED_ALLOW_IPS="10.42.0.0/16"
CMD ["python", "-m", "uvicorn", "app.main:app", \
     "--host", "0.0.0.0", "--port", "3300", \
     "--proxy-headers", \
     "--timeout-graceful-shutdown", "110"]
