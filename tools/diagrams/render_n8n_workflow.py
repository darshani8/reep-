#!/usr/bin/env python3
"""Render REEP's roles -> features -> CRUD -> code -> data -> AWS map as an n8n workflow.

The fourth diagram, and the first one that is not a poster: an importable n8n
workflow (Workflows -> Import from File) in which every role's every feature is
drawn as a Switch whose outputs are CREATE / READ / UPDATE / DELETE (an output
marked with a cross is an operation that role is NOT offered), each offered
operation is an HTTP Request node carrying the real method and path, and the
chain behind it is the FastAPI handler (Code node: file, guard, line), the RDS
tables it touches (Postgres node) and every AWS or third-party service it
reaches (S3 / SES / Bedrock / DynamoDB / ... nodes). The request path from the
phone to the role decision and the whole AWS estate -- schedules, backups, the
voice-platform ingest, observability and the GitHub Actions pipeline -- sit to
the left of the role lanes.

It is a DIAGRAM, not an automation. It is imported inactive, every credential
it names is a stub with no secret behind it, and every URL points at the dev
stack (`ng serve` on :4200 proxying /api to FastAPI on :3300), never at
production.

Input:  docs/diagrams/n8n/reep-feature-inventory.json -- every endpoint the
        FastAPI app serves, classified by role, feature, CRUD operation, gate,
        tables and external systems (see that file's "about").
Output: docs/diagrams/n8n/reep-roles-features-crud.n8n.json

Regenerate with:  python tools/diagrams/render_n8n_workflow.py
Node ids are uuid5 of the node name, so a regeneration diffs cleanly.

Drift check:      python tools/diagrams/render_n8n_workflow.py --check-routes
(run with apps/api-py's venv) lists every route the app serves that the
inventory does not draw, and every drawn route the app no longer serves. A new
endpoint needs a row in the inventory before the diagram can show it.
"""

from __future__ import annotations

import json
import re
import sys
import uuid
from collections import Counter, OrderedDict, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INVENTORY = ROOT / "docs" / "diagrams" / "n8n" / "reep-feature-inventory.json"
OUT = ROOT / "docs" / "diagrams" / "n8n" / "reep-roles-features-crud.n8n.json"

NS = uuid.UUID("6f1d3f5e-2b7a-4f0e-9a51-6e2a3c0b9d41")
DEV_ORIGIN = "http://localhost:4200"  # ng serve; proxy.conf.json forwards /api -> :3300
SITE = "https://reep.sast-skills.com"
TITLE = "REEP - every role, feature and CRUD operation, end to end"

CRUD = ["CREATE", "READ", "UPDATE", "DELETE"]
CRUD_SHORT = {"CREATE": "C", "READ": "R", "UPDATE": "U", "DELETE": "D", "ACTION": "A"}

# Sticky colours as n8n draws them: 1 yellow, 2 tan, 3 pink, 4 green,
# 5 blue, 6 purple, 7 light grey.
ROLES: "OrderedDict[str, dict]" = OrderedDict(
    [
        ("PUBLIC", dict(tag="PUB", title="PUBLIC - no session", color=7,
                        gate="No session cookie. Applicants, the sign-in doors, onboarding, "
                             "password reset and the load balancer's health probe.")),
        ("ACCOUNT", dict(tag="ACC", title="EVERY SIGNED-IN ACCOUNT", color=1,
                         gate="`get_current_session` only -- any role. The account itself: "
                              "session, sign-out, password, linked Google, notification preferences.")),
        ("STUDENT", dict(tag="STU", title="STUDENT", color=4,
                         gate="`_require_student` / `require_student` -- users.role STUDENT, "
                              "own rows only; most screens also pass a per-student feature switch.")),
        ("FACULTY", dict(tag="FAC", title="FACULTY (role MENTOR)", color=5,
                         gate="`require_mentor` (admits MENTOR and ADMIN) + rule 2 "
                              "`_assert_can_access_student`: own mentee group only. Group "
                              "functions (mentees, notebook, verifications) are DERIVED while "
                              "they mentor somebody; console screens only by a Governance grant.")),
        ("ALUMNI", dict(tag="ALU", title="ALUMNI", color=3,
                        gate="`require_alumni` -- no Student or Mentor row, no staff scope.")),
        ("MAIN_ADMIN", dict(tag="ADM", title="MAIN ADMIN (role ADMIN, the placement office)", color=6,
                            gate="`require_admin` (the one console gate) or "
                                 "`require_capability(admin.*)` held by baseline. Not a faculty "
                                 "member: mentor.mentees / notebook / verifications / upskilling "
                                 "are outside its baseline.")),
    ]
)

GROUP_ORDER = [
    "Identity & sign-in",
    "Registration & onboarding",
    "Mail & notifications",
    "Student records & roster",
    "Programme (ledger, English, milestones)",
    "Skills, badges & certifications",
    "Interviews",
    "Mentoring & SWOC",
    "Leave",
    "Jobs & placement",
    "Alumni",
    "Staff self-service",
    "REEP Agent",
    "Institution setup",
    "Imports & analytics",
    "Governance & audit",
    "Deletion & retention",
    "Voice platform",
    "Platform health",
]
# Account-level groups: an ANY_SIGNED_IN endpoint here belongs to the account,
# so it is drawn once in the ACCOUNT lane. Anywhere else, "any signed-in role"
# is drawn in each human lane, because it IS that role's feature (applying for
# leave is a faculty feature, asking the agent is a student feature).
ACCOUNT_GROUPS = {"Identity & sign-in", "Mail & notifications"}
HUMAN_ROLES = ["STUDENT", "FACULTY", "ALUMNI", "MAIN_ADMIN"]

STUB_CREDENTIALS = {
    "aws": {"id": "reepDiagramAws", "name": "REEP AWS task role (diagram stub - no secret)"},
    "postgres": {"id": "reepDiagramRds", "name": "REEP RDS PostgreSQL 17 (diagram stub - no secret)"},
    "githubApi": {"id": "reepDiagramGh", "name": "GitHub OIDC (diagram stub - no secret)"},
    "sentryIoApi": {"id": "reepDiagramSentry", "name": "Sentry (diagram stub - no secret)"},
    "jwtAuth": {"id": "reepDiagramJwt", "name": "AUTH_SECRET HS256 (diagram stub - no secret)"},
}

# External systems an endpoint can reach -> how the diagram draws them.
EXTERNAL = {
    "EFS_DOCUMENT_STORE": dict(label="EFS /data volume", type="readWriteFile", v=1.1,
                               params={"operation": "write", "fileName": "/data/uploads/<stored_name>"},
                               note="reep-data EFS: 6 document stores + interview WAVs"),
    "S3_DOCUMENT_ARCHIVE": dict(label="S3 documents archive", type="awsS3", v=2, cred="aws",
                                params={"operation": "upload", "bucketName": "reep-documents-archive-<account>",
                                        "fileName": "documents/<stored_name>"},
                                note="Object Lock 10 y, PutObject only"),
    "S3_RECORDINGS": dict(label="S3 call recordings", type="awsS3", v=2, cred="aws",
                          params={"operation": "upload", "bucketName": "reep-voice-platform recordings",
                                  "fileName": "recordings/<session_id>.wav"},
                          note="versioned, presigned GET on read"),
    "S3_CANDIDATE_INGEST": dict(label="S3 candidate uploads", type="awsS3", v=2, cred="aws",
                                params={"operation": "upload", "bucketName": "reep-voice-platform uploads",
                                        "fileName": "uploads/<file>"},
                                note="ObjectCreated -> Lambda"),
    "SES_MAIL": dict(label="Amazon SES mail", type="awsSes", v=1, cred="aws",
                     params={"resource": "email", "operation": "send", "fromEmail": "no-reply@sast-skills.com",
                             "toAddresses": ["<recipient>"], "subject": "REEP", "body": "<message>"},
                     note="suppression checked first, mail_logs row"),
    "BEDROCK_NOVA_SONIC": dict(label="Bedrock Nova 2 Sonic", type="httpRequest", v=4.2,
                               params={"method": "POST", "url": "https://bedrock-runtime.ap-northeast-1.amazonaws.com/"
                                       "model/amazon.nova-2-sonic-v1:0/invoke-with-bidirectional-stream",
                                       "options": {}},
                               note="speech-to-speech, SigV4, 480 s cap"),
    "BEDROCK_LLM": dict(label="Bedrock Converse (Nova Pro)", type="httpRequest", v=4.2,
                        params={"method": "POST", "url": "https://bedrock-runtime.ap-south-1.amazonaws.com/"
                                "model/apac.amazon.nova-pro-v1:0/converse", "options": {}},
                        note="app/ai/llm.py, rule-1 egress gate"),
    "LLM_PROVIDER": dict(label="LLM (Bedrock / OpenAI-compatible)", type="httpRequest", v=4.2,
                         params={"method": "POST", "url": "https://bedrock-runtime.ap-south-1.amazonaws.com/"
                                 "model/apac.amazon.nova-pro-v1:0/converse", "options": {}},
                         note="app/ai/llm.py, rule-1 egress gate"),
    "EMBEDDINGS": dict(label="Embeddings (pgvector KB)", type="httpRequest", v=4.2,
                       params={"method": "POST", "url": "https://api.mistral.ai/v1/embeddings", "options": {}},
                       note="optional; full-text only when unset"),
    "GOOGLE_OAUTH": dict(label="Google OAuth / OIDC", type="httpRequest", v=4.2,
                         params={"method": "POST", "url": "https://oauth2.googleapis.com/token", "options": {}},
                         note="RS256 ID token vs JWKS, state + nonce"),
    "DYNAMODB": dict(label="DynamoDB voice sessions", type="awsDynamoDb", v=1, cred="aws",
                     params={"operation": "upsert", "tableName": "reep-voice-sessions-ug"},
                     note="projection; Postgres is the record"),
    "SQS": dict(label="SQS candidate queues", type="awsSqs", v=1, cred="aws",
                params={"queue": "https://sqs.ap-south-1.amazonaws.com/<account>/reep-voice-candidates-ug",
                        "sendInputData": False, "message": "<candidate row>"},
                note="UG / PG, DLQ after 5"),
    "LAMBDA": dict(label="Lambda candidate ingest", type="awsLambda", v=1, cred="aws",
                   params={"function": "reep-voice-candidate-ingest"}, note="validates rows -> SQS"),
    "SSM": dict(label="SSM /reep/voice-platform", type="httpRequest", v=4.2,
                params={"method": "POST", "url": "https://ssm.ap-south-1.amazonaws.com/", "options": {}},
                note="PLATFORM_* parameters at boot"),
    "CLOUDWATCH": dict(label="CloudWatch metrics", type="httpRequest", v=4.2,
                       params={"method": "POST", "url": "https://monitoring.ap-south-1.amazonaws.com/",
                               "options": {}},
                       note="REEP/VoicePlatform PutMetricData"),
    "SENTRY": dict(label="Sentry", type="sentryIo", v=1, cred="sentryIoApi",
                   params={"resource": "event", "operation": "getAll", "organizationSlug": "reep",
                           "projectSlug": "reep-api"},
                   note="scrubbed by app/telemetry_scrub.py"),
    "PDF_RENDER": dict(label="PDF render (in process)", type="code", v=2,
                       params={"language": "python",
                               "pythonCode": "# ReportLab + pypdf, in process -- nothing leaves the machine\n"
                                             "return _input.all()"},
                       note="ReportLab / pypdf, local"),
}

SNAP = 20


def snap(v: float) -> int:
    return int(round(v / SNAP) * SNAP)


class Workflow:
    """A tiny builder for n8n's workflow JSON: nodes, stickies, connections."""

    def __init__(self) -> None:
        self.nodes: list[dict] = []
        self.connections: dict[str, dict] = {}
        self.names: set[str] = set()

    def _unique(self, name: str) -> str:
        name = name.replace("\n", " ").strip()
        base, i = name, 2
        while name in self.names:
            name = f"{base} ({i})"
            i += 1
        self.names.add(name)
        return name

    def node(self, name, type_, version, x, y, params=None, notes=None, cred=None, disabled=False):
        name = self._unique(name)
        node = {
            "parameters": params or {},
            "id": str(uuid.uuid5(NS, name)),
            "name": name,
            "type": type_ if "." in type_ else f"n8n-nodes-base.{type_}",
            "typeVersion": version,
            "position": [snap(x), snap(y)],
        }
        if cred:
            node["credentials"] = {cred: STUB_CREDENTIALS[cred]}
        if notes:
            node["notes"] = notes
            node["notesInFlow"] = True
        if disabled:
            node["disabled"] = True
        self.nodes.append(node)
        return name

    def sticky(self, name, x, y, w, h, color, content):
        return self.node(name, "stickyNote", 1, x, y,
                         {"content": content, "height": snap(h), "width": snap(w), "color": color})

    def link(self, src, dst, output=0):
        main = self.connections.setdefault(src, {"main": []})["main"]
        while len(main) <= output:
            main.append([])
        main[output].append({"node": dst, "type": "main", "index": 0})

    def switch(self, name, x, y, outputs, notes=None):
        rules = []
        for i, key in enumerate(outputs):
            rules.append({
                "conditions": {
                    "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
                    "conditions": [{
                        "id": str(uuid.uuid5(NS, f"{name}/{i}")),
                        "leftValue": "={{ $json.choice }}",
                        "rightValue": key,
                        "operator": {"type": "string", "operation": "equals"},
                    }],
                    "combinator": "and",
                },
                "renameOutput": True,
                "outputKey": key,
            })
        return self.node(name, "switch", 3.2, x, y, {"rules": {"values": rules}, "options": {}}, notes)

    def to_json(self) -> dict:
        return {
            "name": TITLE,
            "nodes": self.nodes,
            "pinData": {},
            "connections": self.connections,
            "active": False,
            "settings": {"executionOrder": "v1", "saveManualExecutions": False, "timezone": "Asia/Kolkata"},
            "versionId": str(uuid.uuid5(NS, "version:" + str(len(self.nodes)))),
            "meta": {"templateCredsSetupCompleted": True},
            "tags": [],
        }


# --------------------------------------------------------------- helpers ---

def md_escape(text: str) -> str:
    return text.replace("|", "\\|")


def short_path(path: str) -> str:
    return path


def guard_short(guard: str) -> str:
    g = re.sub(r"\s+", " ", guard or "").strip()
    return g if len(g) <= 60 else g[:57] + "..."


def plural(n: int, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


# ---------------------------------------------------------- lane building ---

def lane_membership(ep: dict) -> list[tuple[str, str]]:
    """Which lanes draw this endpoint, and how: [(lane, how)].

    how is 'direct' or 'grant' (a faculty member reaches it only by a
    Governance grant, so it is drawn in the faculty lane's granted branch
    rather than as a faculty feature)."""
    roles = list(ep["roles"])
    out: list[tuple[str, str]] = []
    if "ANY_SIGNED_IN" in roles:
        roles.remove("ANY_SIGNED_IN")
        if ep["feature_group"] in ACCOUNT_GROUPS:
            out.append(("ACCOUNT", "direct"))
        else:
            roles += [r for r in HUMAN_ROLES if r not in roles]
    if "SYSTEM" in roles:
        roles.remove("SYSTEM")
        if "PUBLIC" not in roles:
            roles.append("PUBLIC")
    for role in roles:
        if role == "FACULTY" and ep.get("faculty_access") == "GRANT":
            out.append(("FACULTY", "grant"))
        else:
            out.append((role, "direct"))
    seen, uniq = set(), []
    for item in out:
        if item not in seen:
            seen.add(item)
            uniq.append(item)
    return uniq


def build_lanes(endpoints: list[dict]):
    """lane -> group -> feature -> [endpoint], plus the faculty grant bucket."""
    lanes: dict[str, dict[str, dict[str, list[dict]]]] = {k: defaultdict(lambda: defaultdict(list)) for k in ROLES}
    grants: dict[str, list[dict]] = defaultdict(list)
    for ep in endpoints:
        for lane, how in lane_membership(ep):
            if how == "grant":
                grants[ep.get("capability") or "admin.*"].append(ep)
            else:
                lanes[lane][ep["feature_group"]][ep["feature"]].append(ep)
    ordered = {}
    for lane, groups in lanes.items():
        ordered[lane] = OrderedDict(
            (g, OrderedDict(sorted(groups[g].items(), key=lambda kv: kv[0].lower())))
            for g in sorted(groups, key=lambda g: GROUP_ORDER.index(g) if g in GROUP_ORDER else 99)
        )
    return ordered, OrderedDict(sorted(grants.items()))


def screens_for(ep: dict, lane: str, route_roles: dict[str, set[str]]) -> list[str]:
    """The Angular routes calling this endpoint that THIS lane's role can open."""
    want = {"ACCOUNT": {"ANY_SIGNED_IN", "STUDENT", "FACULTY", "ALUMNI", "MAIN_ADMIN"}}.get(lane, {lane})
    out = []
    for route in ep.get("frontend") or []:
        roles = route_roles.get(route)
        if roles is None or roles & want or ("ANY_SIGNED_IN" in roles and lane in HUMAN_ROLES):
            out.append(route)
    return out


# Heights used by the layout (n8n draws a node about 100 px square with a
# two-line label under it).
PITCH = 180
TABLE_ROW = 31


def table_height(n_rows: int, footer: list[str], width: int) -> int:
    """Measured off n8n's renderer: a table row is ~40 units, a footer line ~18
    units and wraps at about one character per 5.6 units of sticky width."""
    per_line = max(40, int(width / 5.6))
    wrapped = sum(max(1, -(-len(line) // per_line)) for line in footer)
    return 130 + 40 * n_rows + 18 * wrapped + 30


def feature_table(lane: str, feature: str, eps: list[dict], route_roles) -> tuple[str, int, int]:
    ops = {e["crud"] for e in eps}
    flags = " · ".join(f"**{CRUD_SHORT[op]}** {'✓' if op in ops else '✗'}" for op in CRUD)
    if "ACTION" in ops:
        flags += " · **A** ✓"
    rows, api_only, screens = [], False, []
    order = {op: i for i, op in enumerate(CRUD + ["ACTION"])}
    for e in sorted(eps, key=lambda e: (order[e["crud"]], e["path"], e["method"])):
        sc = screens_for(e, lane, route_roles)
        for s in sc:
            if s not in screens:
                screens.append(s)
        mark = "" if sc else " †"
        api_only = api_only or not sc
        rows.append(f"| {CRUD_SHORT[e['crud']]} | {e['method']} | `{md_escape(e['path'])}` | "
                    f"{md_escape(e['verb'])}{mark} |")
    modules = sorted({e["module"] for e in eps})
    guards = sorted({guard_short(e["guard"]) for e in eps})
    caps = sorted({e["capability"] for e in eps if e.get("capability")})
    tables = sorted({t for e in eps for t in e["tables"]})
    ext = sorted({x for e in eps for x in e["external"]})
    lines = [
        f"### {feature}",
        f"{flags}  ·  {plural(len(eps), 'endpoint')}",
        "",
        "| Op | Method | Path | What it does |",
        "|---|---|---|---|",
        *rows,
        "",
        f"**Screens** {' '.join(f'`{s}`' for s in screens) if screens else '— none for this role (API only)'}",
        f"**Code** {' '.join(f'`{m}`' for m in modules)}",
        f"**Gate** {' · '.join(f'`{g}`' for g in guards)}" + (f" · capability {' '.join(f'`{c}`' for c in caps)}" if caps else ""),
        f"**Tables** {' '.join(f'`{t}`' for t in tables) if tables else '—'}",
        f"**AWS / external** {' · '.join(EXTERNAL[x]['label'] for x in ext if x in EXTERNAL) or '—'}",
    ]
    if api_only and screens:
        lines.append("† no screen this role can open calls it (API only)")
    longest = max([len(e["path"]) for e in eps] + [0])
    longest_verb = max([len(e["verb"]) for e in eps] + [0])
    width = max(900, 7.4 * (longest + longest_verb) + 260)
    footer = lines[len(lines) - (6 if api_only and screens else 5):]
    return "\n".join(lines), int(width), table_height(len(rows), footer, int(width))


def render_lane(wf: Workflow, lane: str, groups, lx: int, top: int, route_roles, grants=None,
                title_suffix: str = "") -> tuple[str, int, int]:
    """Draw one lane; returns (entry switch name, bottom y, width)."""
    role = ROLES[lane]
    tag = role["tag"]
    col_domain, col_feature = lx + 300, lx + 600
    col_op, col_code, col_data, col_table = lx + 900, lx + 1180, lx + 1440, lx + 1700

    # Measure first, so the table column can be as wide as the widest table.
    tables = {}
    table_w = 900
    for g, feats in groups.items():
        for f, eps in feats.items():
            md, w, h = feature_table(lane, f, eps, route_roles)
            tables[(g, f)] = (md, w, h)
            table_w = max(table_w, w)
    lane_w = (col_table - lx) + table_w + 140

    y = top + 140  # room for the lane title
    domain_entries: list[tuple[str, str]] = []
    n_eps = n_feats = 0
    crud_count = Counter()
    for g, feats in groups.items():
        dom_top = y
        y += 110
        feature_switches = []
        dom_switch_y = None
        for f, eps in feats.items():
            n_feats += 1
            n_eps += len(eps)
            ops = OrderedDict()
            for op in CRUD + ["ACTION"]:
                sel = [e for e in eps if e["crud"] == op]
                if sel:
                    ops[op] = sel
                    crud_count[op] += 1
            tables_used = sorted({t for e in eps for t in e["tables"]})
            exts = [x for x in sorted({x for e in eps for x in e["external"]}) if x in EXTERNAL]
            targets = (["PG"] if tables_used else []) + exts
            rows = max(len(ops), len(targets), 1)
            md, _w, th = tables[(g, f)]
            block_h = max(rows * PITCH, th + 40)
            center = y + (rows - 1) * PITCH / 2
            if dom_switch_y is None:
                dom_switch_y = center

            outputs = CRUD + (["ACTION"] if "ACTION" in ops else [])
            labels = [o if o in ops else f"{o} ✗" for o in outputs]
            sw = wf.switch(f"{tag} · {f}", col_feature, center, labels,
                           notes="CRUD " + " ".join(CRUD_SHORT[o] + ("✓" if o in ops else "✗") for o in CRUD))
            feature_switches.append(sw)

            code_lines = [f"# {f} -- FastAPI handlers ({ROLES[lane]['title']})"]
            for op, sel in ops.items():
                for e in sel:
                    code_lines.append(f"# {op:<6} {e['method']:<6} {e['path']}  ->  "
                                      f"{e['module']}::{e['handler']}" + (f" (line {e['line']})" if e.get("line") else ""))
            code_lines.append("# gate: " + " | ".join(sorted({guard_short(e['guard']) for e in eps})))
            code_lines.append("return _input.all()")
            modules = sorted({e["module"] for e in eps})
            code = wf.node(f"{tag} · {f} · FastAPI", "code", 2, col_code, center,
                           {"language": "python", "pythonCode": "\n".join(code_lines)},
                           notes=", ".join(m.replace("routers/", "") for m in modules)[:60])

            op_y0 = center - (len(ops) - 1) * PITCH / 2
            for i, (op, sel) in enumerate(ops.items()):
                first = sel[0]
                origin = DEV_ORIGIN.replace("http", "ws") if first["method"] == "WS" else DEV_ORIGIN
                method = "GET" if first["method"] == "WS" else first["method"]
                params = {"method": method, "url": origin + first["path"], "options": {}}
                more = f" +{len(sel) - 1}" if len(sel) > 1 else ""
                name = wf.node(f"{tag} · {f} · {op}", "httpRequest", 4.2, col_op, op_y0 + i * PITCH,
                               params, notes=f"{first['method']} {first['path']}{more}")
                wf.link(sw, name, outputs.index(op))
                wf.link(name, code)

            t_y0 = center - (len(targets) - 1) * PITCH / 2
            for i, t in enumerate(targets):
                ty = t_y0 + i * PITCH
                if t == "PG":
                    by_op = OrderedDict()
                    for op, sel in ops.items():
                        ts = sorted({x for e in sel for x in e["tables"]})
                        if ts:
                            by_op[op] = ts
                    query = ["-- RDS PostgreSQL 17 (reep-postgres, db reep_py) via SQLAlchemy 2.0 + psycopg 3"]
                    query += [f"-- {op:<6} {', '.join(ts)}" for op, ts in by_op.items()]
                    name = wf.node(f"{tag} · {f} · PostgreSQL", "postgres", 2.5, col_data, ty,
                                   {"operation": "executeQuery", "query": "\n".join(query), "options": {}},
                                   notes=", ".join(tables_used)[:60], cred="postgres")
                else:
                    spec = EXTERNAL[t]
                    name = wf.node(f"{tag} · {f} · {spec['label']}", spec["type"], spec["v"], col_data, ty,
                                   json.loads(json.dumps(spec["params"])), notes=spec["note"], cred=spec.get("cred"))
                wf.link(code, name)

            wf.sticky(f"Endpoints · {tag} · {f}", col_table, y - 60, table_w, th, role["color"], md)
            y += block_h + 70

        wf.sticky(f"Area · {tag} · {g}", col_domain - 60, dom_top, lane_w - (col_domain - 60 - lx) - 40,
                  y - dom_top - 20, 7,
                  f"## {g}\n{plural(len(feats), 'feature')} · "
                  f"{plural(sum(len(v) for v in feats.values()), 'endpoint')}")
        dsw = wf.switch(f"{tag} · {g}", col_domain, dom_switch_y, list(feats.keys()),
                        notes=plural(len(feats), "feature"))
        for i, fs in enumerate(feature_switches):
            wf.link(dsw, fs, i)
        domain_entries.append((g, dsw))
        y += 40

    if grants:
        y = render_grants(wf, lane, grants, lx, y, lane_w, domain_entries)

    first_y = top + 260
    lane_switch = wf.switch(f"{role['title']}{title_suffix} · feature areas", lx, first_y,
                            [g for g, _ in domain_entries], notes=plural(len(domain_entries), "area"))
    for i, (_, dsw) in enumerate(domain_entries):
        wf.link(lane_switch, dsw, i)

    crud_line = " · ".join(f"{CRUD_SHORT[o]} {crud_count[o]}" for o in CRUD + ["ACTION"] if crud_count[o])
    wf.sticky(f"Lane · {role['title']}{title_suffix}", lx - 80, top, lane_w + 120, y - top + 40, role["color"],
              f"# {role['title']}{title_suffix}\n"
              f"**{plural(n_feats, 'feature')} · {plural(n_eps, 'endpoint')}** "
              f"(features offering each operation: {crud_line})\n\n{role['gate']}")
    return lane_switch, y + 40, lane_w


def render_grants(wf, lane, grants, lx, y, lane_w, domain_entries):
    """The faculty lane's branch for console screens reached only by a grant."""
    tag = ROLES[lane]["tag"]
    col_domain, col_feature, col_table = lx + 300, lx + 600, lx + 1700
    dom_top = y
    y += 110
    keys = list(grants.keys())
    rows = ["| Capability | Main Admin features it opens | C | R | U | D | Endpoints |", "|---|---|---|---|---|---|---|"]
    targets = []
    for i, key in enumerate(keys):
        eps = grants[key]
        feats = sorted({e["feature"] for e in eps})
        ops = Counter(e["crud"] for e in eps)
        rows.append(f"| `{key}` | {md_escape(', '.join(feats))} | " +
                    " | ".join(str(ops.get(o, 0) or "—") for o in CRUD) + f" | {len(eps)} |")
        name = wf.node(f"{tag} · granted {key}", "noOp", 1, col_feature, y + i * PITCH, {},
                       notes=("→ " + ", ".join(feats))[:60])
        targets.append(name)
    md = "\n".join([
        "### Console screens a faculty member reaches only by a Governance grant",
        "The Main Admin grants an `admin.*` capability to a named faculty account in **Who can do what** "
        "(with a reason, an optional scope rung and an expiry; a deputy's PII grant waits for a second "
        "signature). The endpoints are exactly the Main Admin lane's -- `require_capability` admits the "
        "holder -- and rule 2 still narrows anything about one student to the holder's own mentees.",
        "",
        *rows,
    ])
    table_w = lane_w - (col_table - lx) - 100
    table_h = 330 + 58 * (len(keys) + 1)
    wf.sticky(f"Endpoints · {tag} · granted", col_table, dom_top + 50, table_w, table_h, ROLES[lane]["color"], md)
    sw = wf.switch(f"{tag} · Granted by the Main Admin", col_domain, y, keys,
                   notes=plural(len(keys), "capability"))
    for i, t in enumerate(targets):
        wf.link(sw, t, i)
    bottom = max(y + len(keys) * PITCH, dom_top + 50 + table_h) + 40
    wf.sticky(f"Area · {tag} · granted", col_domain - 60, dom_top, lane_w - 340, bottom - dom_top, 7,
              f"## Granted console screens (Governance)\n{plural(len(keys), 'capability')} · "
              f"{plural(sum(len(v) for v in grants.values()), 'endpoint')}")
    domain_entries.append(("Granted by the Main Admin", sw))
    return bottom + 40


# ----------------------------------------------------- the left-hand side ---

def render_request_path(wf: Workflow, x0: int, y: int) -> tuple[str, int, dict]:
    """The phone -> edge -> API -> session -> role decision chain."""
    step = 300
    xs = [x0 + i * step for i in range(14)]
    n = []
    n.append(wf.node("A person opens REEP", "manualTrigger", 1, xs[0], y,
                     notes="phone browser or installed PWA"))
    n.append(wf.node("Angular 22 SPA (apps/web)", "httpRequest", 4.2, xs[1], y,
                     {"method": "GET", "url": DEV_ORIGIN + "/api/auth/me", "options": {}},
                     notes="fetch('/api/…', credentials: include)"))
    n.append(wf.node("Service worker reep-sw.js", "code", 2, xs[2], y,
                     {"jsCode": "// apps/web/public/reep-sw.js\n"
                                "// same-origin /api/* -> event.stopImmediatePropagation(), no respondWith:\n"
                                "// the browser makes the request itself, so ngsw never invents a 504.\n"
                                "// ngsw-config.json has NO dataGroups: no student data in Cache Storage (rule 1).\n"
                                "importScripts('./ngsw-worker.js');\nreturn $input.all();"},
                     notes="/api/* passes through untouched"))
    n.append(wf.node("DNS reep.sast-skills.com", "noOp", 1, xs[3], y, notes="external zone -> CloudFront"))
    n.append(wf.node("AWS WAF web ACL reep-edge", "filter", 2.2, xs[4], y,
                     {"conditions": {"options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict",
                                                 "version": 2},
                                     "conditions": [{"id": str(uuid.uuid5(NS, "waf")),
                                                     "leftValue": "={{ $json.requestsPerFiveMinutesFromThisIp }}",
                                                     "rightValue": 2000,
                                                     "operator": {"type": "number", "operation": "lte"}}],
                                     "combinator": "and"}, "options": {}},
                     notes="us-east-1: common, bad-inputs, rate 2000/5 min"))
    cf = wf.switch("CloudFront EW482RJIK9CVE", xs[5], y, ["default -> S3", "/api/* -> ALB"],
                   notes="TLS 1.3, alias reep.sast-skills.com")
    n.append(cf)
    s3 = wf.node("S3 SPA bucket reep-web", "awsS3", 2, xs[6], y - 220,
                 {"operation": "download", "bucketName": "reep-web-20260827213147410900000003",
                  "fileKey": "index.html"}, notes="OAC, hashed assets immutable 1 y", cred="aws")
    alb = wf.node("ALB reep-alb :443", "awsElb", 1, xs[6], y + 60,
                  {"resource": "loadBalancer", "operation": "get", "loadBalancerId": "reep-alb"},
                  notes="CloudFront prefix list only; TG reep-api :3300", cred="aws")
    ecs = wf.node("ECS Fargate · service api", "noOp", 1, xs[7], y + 60,
                  notes="ARM64, 512 CPU / 1 GiB, 2-10 tasks")
    uv = wf.node("uvicorn -> FastAPI app.main", "code", 2, xs[8], y + 60,
                 {"language": "python", "pythonCode":
                  "# Dockerfile CMD: python -m uvicorn app.main:app --host 0.0.0.0 --port 3300 --proxy-headers\n"
                  "#   --timeout-graceful-shutdown 110 --ws-per-message-deflate false\n"
                  "# 35 routers under prefix='/api', 7 self-prefixed /api/..., 2 under /api/v1,\n"
                  "# plus /health, /ready and the voice_platform routers\n"
                  "return _input.all()"}, notes="python -m uvicorn app.main:app :3300")
    mw = wf.node("Middleware chain", "code", 2, xs[9], y + 60,
                 {"language": "python", "pythonCode":
                  "# outermost first: Sentry ASGI wrapper (scrubbed: app/telemetry_scrub.py)\n"
                  "# -> security headers (nosniff, DENY, HSTS) -> RequestTraceMiddleware\n"
                  "# (X-Request-ID, access line, tags the Sentry scope) -> CORS\n"
                  "return _input.all()"}, notes="Sentry wrap, headers, X-Request-ID, CORS")
    jwt = wf.node("security.py · verify reep_session", "jwt", 1, xs[10], y + 60,
                  {"operation": "verify", "token": "={{ $json.cookies.reep_session }}"},
                  notes="HS256 AUTH_SECRET + users.token_version", cred="jwtAuth")
    wf.link(n[0], n[1]); wf.link(n[1], n[2]); wf.link(n[2], n[3]); wf.link(n[3], n[4]); wf.link(n[4], cf)
    wf.link(cf, s3, 0); wf.link(cf, alb, 1); wf.link(alb, ecs); wf.link(ecs, uv); wf.link(uv, mw); wf.link(mw, jwt)
    role_sw = wf.switch("Who is calling? (users.role in the session)", xs[11], y + 60,
                        ["PUBLIC", "ACCOUNT", "STUDENT", "FACULTY", "ALUMNI", "MAIN ADMIN"],
                        notes="cookie absent -> PUBLIC; 401 X-Reep-Session: retired")
    wf.link(jwt, role_sw)
    return role_sw, xs[11], {"spa": n[1], "cloudfront": cf, "alb": alb}


def render_left(wf: Workflow, x0: int, y0: int, inv: dict, stats: dict, edge: dict) -> None:
    """Title, legend, AWS estate, schedules, backups, voice platform, CI/CD, data model."""
    W = 3900
    # ---- title and legend
    wf.sticky("Title", x0, y0, 1900, 1380, 6,
              f"# {TITLE}\n"
              f"**{stats['endpoints']} endpoints** served by the FastAPI app (`apps/api-py`), every one drawn under "
              f"each role that can call it, grouped as **role -> feature area -> feature -> CRUD operation -> "
              f"API call -> FastAPI handler -> RDS tables -> AWS / external service**. "
              f"{stats['features']} role-features in {len(ROLES)} lanes; Angular 22 SPA (`apps/web`), "
              f"FastAPI + SQLAlchemy 2.0 + Pydantic v2 on Python 3.14, PostgreSQL 17 on RDS, AWS CDK.\n\n"
              f"Inventory taken {inv['about']['taken_on']} at `{inv['about']['commit']}` from the live route table "
              f"(`app.routes`, {stats['endpoints']} rows incl. 3 WebSockets) and classified handler by handler, "
              f"then adversarially re-checked against the guards in the code. Regenerate: "
              f"`python tools/diagrams/render_n8n_workflow.py`.\n\n"
              f"**This is a diagram, not an automation**: it imports inactive, the credentials are named stubs with "
              f"no secret, and every URL points at the dev stack (`{DEV_ORIGIN}`, `ng serve` proxying /api to :3300).")
    wf.sticky("Legend", x0 + 2000, y0, 1900, 1380, 7, "\n".join([
        "## How to read it",
        "| Node | Means |",
        "|---|---|",
        "| **Switch** (role, area, feature) | a choice. A feature's outputs are always **CREATE · READ · UPDATE · "
        "DELETE** (+ ACTION for a sign-in, a code, a socket); an output written `DELETE ✗` is an operation "
        "**that role is not offered**. |",
        "| **HTTP Request** (globe) | one offered operation: the method and path of its first endpoint; the "
        "subtitle says how many more. The feature's yellow-green-blue card lists every endpoint. |",
        "| **Code** `{ }` | the FastAPI handler(s): file, function, line and the gate it runs |",
        "| **Postgres** (elephant) | the RDS tables that feature reads or writes, per operation |",
        "| **S3 · SES · DynamoDB · SQS · Lambda · ELB** | the AWS service by its own icon; Bedrock, Google, "
        "SSM and CloudWatch are HTTP nodes on their real endpoints |",
        "| **Read/Write Files** | the EFS `/data` volume (uploads, interview WAVs) |",
        "| **Schedule Trigger** | EventBridge Scheduler / AWS Backup cron, in IST, or the Route 53 health "
        "checker's 30 s interval |",
        "| **GitHub** | a GitHub Actions workflow |",
        "| greyed (deactivated) node | exists in code, not deployed / not running |",
        "",
        "**Lanes**: PUBLIC grey · ACCOUNT yellow · STUDENT green · FACULTY blue · ALUMNI pink · MAIN ADMIN purple. "
        "A '†' in a card marks an endpoint no screen of that role calls (API only).",
        "**Two fences, checked separately**: the role gate / capability decides WHICH SCREENS; rule 2 "
        "(`_assert_can_access_student`) decides WHICH STUDENTS. A capability never relaxes the student filter.",
    ]))

    # ---- request path label
    wf.sticky("Request path", x0, y0 + 1460, W + 400, 640, 2,
              "## 1 · One request, phone to role decision\n"
              "Same origin under `/api`, so the httpOnly `reep_session` cookie rides every call. CloudFront's "
              "default behaviour serves the SPA from S3; `/api/*` (HTTP and the interview WebSockets) goes to the "
              "ALB and an ECS Fargate task running uvicorn + FastAPI. `security.py` verifies the HS256 JWT and "
              "the account's `token_version` (one live session per account), then the role decides the lane.")

    # ---- AWS estate
    ay = y0 + 2120
    wf.sticky("AWS estate", x0, ay, W, 2780, 2,
              "## 2 · The AWS estate behind the api task (ap-south-1 unless noted)\n"
              "Every call to AWS APIs or the internet leaves the private subnets through the NAT instance "
              "(t4g.nano) -- there are no VPC endpoints; RDS and EFS traffic stays inside the VPC. "
              "Stacks: `reep-core` (ap-south-1), `reep-edge-waf` (us-east-1), `reep-dr-vault` (ap-southeast-1), "
              "`reep-voice-platform` (ap-south-1). Every resource in reep-core, reep-edge-waf and reep-dr-vault is "
              "DeletionPolicy Retain; reep-voice-platform retains only its two S3 buckets and two DynamoDB tables.")
    c0, c1, c2, c3 = x0 + 120, x0 + 900, x0 + 1700, x0 + 2600
    r = lambda i: ay + 200 + i * 220  # noqa: E731
    ecr = wf.node("ECR reep/api (multi-arch)", "noOp", 1, c0, r(0), notes="image pulled at task start")
    sec = wf.node("Secrets Manager reep/app + reep/external", "noOp", 1, c0, r(1),
                  notes="AUTH_SECRET, DATABASE_URL, Google, Sentry")
    task = wf.node("ECS task reep-api (api service + jobs)", "noOp", 1, c1, r(2),
                   notes="task role reep-api-task, no keys")
    wf.link(ecr, task); wf.link(sec, task)
    rds = wf.node("RDS PostgreSQL 17 reep-postgres", "postgres", 2.5, c2, r(0),
                  {"operation": "executeQuery", "query": "-- ~112 tables, pgvector Knowledge Base\n-- db.t4g.small, "
                   "gp3 20->100 GB, automated backups 35 d, Single-AZ", "options": {}},
                  notes="db reep_py, :5432 from api SG only", cred="postgres")
    efs = wf.node("EFS reep-data -> /data", "readWriteFile", 1.1, c2, r(1),
                  {"operation": "write", "fileName": "/data/uploads/<stored_name>"},
                  notes="uploads + interview-audio, IA after 30 d")
    arch = wf.node("S3 reep-documents-archive", "awsS3", 2, c2, r(2),
                   {"operation": "upload", "bucketName": "reep-documents-archive-<account>",
                    "fileName": "documents/<stored_name>"}, notes="Object Lock 10 y, Put + List only", cred="aws")
    ses = wf.node("Amazon SES no-reply@sast-skills.com", "awsSes", 1, c2, r(3),
                  {"resource": "email", "operation": "send", "fromEmail": "no-reply@sast-skills.com",
                   "toAddresses": ["<recipient>"], "subject": "REEP", "body": "<message>"},
                  notes="config set reep-transactional", cred="aws")
    sesn = wf.node("SNS reep-ses-notifications", "awsSns", 1, c3, r(3),
                   {"topic": "reep-ses-notifications", "subject": "SES event", "message": "<event>"},
                   notes="SES event stream + rate alarms; hand-made, no stack", cred="aws")
    sonic = wf.node("Bedrock Nova 2 Sonic (ap-northeast-1)", "httpRequest", 4.2, c2, r(4),
                    EXTERNAL["BEDROCK_NOVA_SONIC"]["params"], notes="mock interviewer, 8-min stream cap")
    pro = wf.node("Bedrock Nova Pro (Converse)", "httpRequest", 4.2, c2, r(5),
                  EXTERNAL["BEDROCK_LLM"]["params"], notes="REEP Agent, resume brief")
    goog = wf.node("Google OAuth / OIDC", "httpRequest", 4.2, c2, r(6),
                   EXTERNAL["GOOGLE_OAUTH"]["params"], notes="sign-in for every role")
    sen = wf.node("Sentry reep-api / reep-web", "sentryIo", 1, c2, r(7),
                  {"resource": "issue", "operation": "getAll", "organizationSlug": "bgs-college-of-engineering-and",
                   "projectSlug": "reep-api"},
                  notes="PII off, scrubbed payloads", cred="sentryIoApi")
    cwl = wf.node("CloudWatch Logs /reep/api", "httpRequest", 4.2, c2, r(8),
                  {"method": "POST", "url": "https://logs.ap-south-1.amazonaws.com/", "options": {}},
                  notes="metric filters: dropped turns, mail failed")
    alarms = wf.node("CloudWatch alarms", "httpRequest", 4.2, c3, r(8),
                     {"method": "POST", "url": "https://monitoring.ap-south-1.amazonaws.com/", "options": {}},
                     notes="5xx, no healthy api, RDS, backups")
    alerts = wf.node("SNS reep-alerts (email)", "awsSns", 1, c3 + 600, r(8),
                     {"topic": "reep-alerts", "subject": "REEP alarm", "message": "<alarm>"},
                     notes="ops mailbox", cred="aws")
    for t in (rds, efs, arch, ses, sonic, pro, goog, sen, cwl):
        wf.link(task, t)
    wf.link(ses, sesn); wf.link(cwl, alarms); wf.link(alarms, alerts)
    wf.link(edge["spa"], sen)  # the browser reports to reep-web directly
    up = wf.node("Route 53 health check reep-uptime", "scheduleTrigger", 1.2, c0, r(10),
                 {"rule": {"interval": [{"field": "seconds", "secondsInterval": 30}]}},
                 notes="TCP 443 every 30 s (us-east-1)")
    upa = wf.node("Alarm reep-site-unreachable", "noOp", 1, c1, r(10),
                  notes="missing data = BREACHING (us-east-1)")
    ups = wf.node("SNS reep-uptime-alerts", "awsSns", 1, c2, r(10),
                  {"topic": "reep-uptime-alerts", "subject": "REEP down", "message": "<alarm>"},
                  notes="email, confirm subscription (us-east-1)", cred="aws")
    wf.link(up, upa); wf.link(upa, ups)
    cfl = wf.node("S3 reep-cloudfront-logs", "awsS3", 2, c3, r(0),
                  {"operation": "upload", "bucketName": "reep-cloudfront-logs-<account>", "fileName": "AWSLogs/..."},
                  notes="no query/cookie/referer; 30 d (us-east-1)", cred="aws")
    albl = wf.node("S3 reep-alb-logs", "awsS3", 2, c3, r(1),
                   {"operation": "upload", "bucketName": "reep-alb-logs-20260827213148167800000004", "fileName": "AWSLogs/..."},
                   notes="expire 90 d", cred="aws")
    edge_src = wf.node("Edge request logs", "noOp", 1, c1, r(0), notes="CloudFront + ALB access logs")
    wf.link(edge_src, cfl); wf.link(edge_src, albl)
    wf.link(edge["cloudfront"], edge_src, 1); wf.link(edge["alb"], edge_src)

    # ---- schedules
    sy = ay + 2840
    jobs = [j for j in inv["jobs"] if j.get("diagram") == "schedule"]
    wf.sticky("Schedules", x0, sy, W, 300 + 240 * max(len(jobs), 1), 1,
              "## 3 · What runs with nobody watching (EventBridge Scheduler -> ECS RunTask on reep-api)\n"
              "Same image, roles and EFS mount as the api. Order is load-bearing: the ledger (23:30) and the dump "
              "(01:00) and the archive sweep (02:00) all run BEFORE retention (03:00), the one scheduled "
              "destructor -- a copy taken after it never saw what it removed. Writers may PutObject and List, "
              "never Get or Delete.")
    for i, j in enumerate(jobs):
        jy = sy + 200 + i * 240
        trig = wf.node(f"{j['schedule_label']}", "scheduleTrigger", 1.2, c0, jy,
                       {"rule": {"interval": [{"field": "cronExpression", "expression": j["cron_n8n"]}]}},
                       notes=j["rule"], disabled=bool(j.get("disabled")))
        run = wf.node(f"RunTask · {j['command']}", "code", 2, c1, jy,
                      {"language": "python", "pythonCode": f"# {j['command']}\n# {j['purpose']}\nreturn _input.all()"},
                      notes=f"{j['crud']}: {j['short']}"[:60])
        wf.link(trig, run)
        for k, tgt in enumerate(j["targets"]):
            spec = tgt
            name = wf.node(f"{j['name']} -> {spec['label']}", spec["type"], spec["v"], c2 + k * 520, jy,
                           spec.get("params", {}), notes=spec.get("note"), cred=spec.get("cred"))
            wf.link(run, name)

    # ---- backups and DR
    by = sy + 300 + 240 * max(len(jobs), 1) + 60
    wf.sticky("Backups", x0, by, W, 980, 3,
              "## 4 · Backups and disaster recovery\n"
              "PHYSICAL copies (AWS Backup, 35 days = RDS's ceiling, plus a monthly 365-day archive of RDS only) "
              "and the LOGICAL ones above (identity ledger, pg_dump daily + monthly archive, documents archive) -- "
              "the logical half is what survives an engine or vendor change.")
    daily = wf.node("AWS Backup daily 00:30 IST", "scheduleTrigger", 1.2, c0, by + 200,
                    {"rule": {"interval": [{"field": "cronExpression", "expression": "0 30 0 * * *"}]}},
                    notes="plan reep-daily: RDS + EFS, 35 d")
    monthly = wf.node("AWS Backup monthly 21:30 IST on the 1st", "scheduleTrigger", 1.2, c0, by + 420,
                      {"rule": {"interval": [{"field": "cronExpression", "expression": "0 30 21 1 * *"}]}},
                      notes="plan reep-archive: RDS only, 365 d")
    restore = wf.node("Restore test Sundays 09:30 IST", "scheduleTrigger", 1.2, c0, by + 640,
                      {"rule": {"interval": [{"field": "cronExpression", "expression": "0 30 9 * * 0"}]}},
                      notes="throwaway RDS from latest point")
    vault = wf.node("Backup vault reep-vault", "noOp", 1, c2, by + 300, notes="vault lock governance, min 35 d")
    dr = wf.node("DR vault reep-vault-dr (Singapore)", "noOp", 1, c3, by + 300, notes="cross-region copy")
    proof = wf.node("Restore from the newest point in reep-vault", "noOp", 1, c1, by + 680,
                    notes="throwaway instance, 1 h validation")
    src_db = wf.node("Backup source: RDS reep-postgres", "postgres", 2.5, c1, by + 140,
                     {"operation": "executeQuery", "query": "-- selected by plan reep-daily and plan reep-archive",
                      "options": {}}, notes="daily + monthly selections", cred="postgres")
    src_fs = wf.node("Backup source: EFS reep-data", "readWriteFile", 1.1, c1, by + 420,
                     {"operation": "read", "fileSelector": "/data/**"}, notes="daily selection only")
    wf.link(daily, src_db); wf.link(daily, src_fs); wf.link(monthly, src_db)
    wf.link(src_db, vault); wf.link(src_fs, vault); wf.link(vault, dr)
    wf.link(restore, proof)

    # ---- voice platform ingest
    vy = by + 1040
    wf.sticky("Voice platform", x0, vy, W, 760, 5,
              "## 5 · Voice platform (stack reep-voice-platform)\n"
              "Bulk candidate files land in S3; the Lambda validates each row and queues it per degree. "
              "**No queue consumer is deployed** -- the admin bulk upload stores straight into Postgres by "
              "default. Calls run through `/api/platform/media-bridge` inside the api task (lane MAIN ADMIN and "
              "STUDENT), recordings go to S3, live state is projected to DynamoDB.")
    ing = wf.node("S3 uploads/ (ObjectCreated)", "awsS3", 2, c0, vy + 220,
                  {"operation": "upload", "bucketName": "reep-voice-platform uploads", "fileName": "uploads/<file>"},
                  notes="CSV / JSON / JSONL", cred="aws")
    lam = wf.node("Lambda reep-voice-candidate-ingest", "awsLambda", 1, c1, vy + 220,
                  {"function": "reep-voice-candidate-ingest"}, notes="validation.py, rejects/ report", cred="aws")
    sqs = wf.node("SQS reep-voice-candidates-ug / -pg", "awsSqs", 1, c2, vy + 220,
                  {"queue": "https://sqs.ap-south-1.amazonaws.com/<account>/reep-voice-candidates-ug",
                   "sendInputData": False, "message": "<candidate>"}, notes="visibility 60 s, 4 d", cred="aws")
    dlq = wf.node("SQS dead-letter queues", "awsSqs", 1, c3, vy + 120,
                  {"queue": "https://sqs.ap-south-1.amazonaws.com/<account>/reep-voice-candidates-ug-dlq",
                   "sendInputData": False, "message": "<candidate>"}, notes="after 5 receives, 14 d", cred="aws")
    worker = wf.node("Queue worker (NOT deployed)", "code", 2, c3, vy + 340,
                     {"language": "python", "pythonCode": "# python -m app.voice_platform.queue.worker --degree UG|PG\n"
                      "# would upsert platform_candidates on external_id\nreturn _input.all()"},
                     notes="no service or schedule runs it", disabled=True)
    ddb = wf.node("DynamoDB reep-voice-sessions-ug / -pg", "awsDynamoDb", 1, c1, vy + 480,
                  {"operation": "upsert", "tableName": "reep-voice-sessions-ug"}, notes="TTL 180 d, PITR", cred="aws")
    rec = wf.node("S3 recordings/ (versioned)", "awsS3", 2, c2, vy + 480,
                  {"operation": "upload", "bucketName": "reep-voice-platform recordings",
                   "fileName": "recordings/<session_id>.wav"}, notes="no lifecycle; presigned GET", cred="aws")
    ssm = wf.node("SSM /reep/voice-platform/PLATFORM_*", "httpRequest", 4.2, c0, vy + 480,
                  EXTERNAL["SSM"]["params"], notes="read by the api at boot")
    wf.link(ing, lam); wf.link(lam, sqs); wf.link(sqs, dlq); wf.link(sqs, worker)
    for t in (ssm, ddb, rec, sqs):
        wf.link(task, t)  # SSM read once at boot; SQS only for bulk mode=queue

    # ---- CI/CD
    gy = vy + 820
    wf.sticky("CI/CD", x0, gy, W, 1560, 7,
              "## 6 · Shipping it (GitHub Actions; agents hold no AWS credentials)\n"
              "`ci.yml` runs the five checks the (not yet applied) ruleset in `.github/rulesets/main.json` will "
              "require. `deploy.yml` assumes `reep-github-deploy` by OIDC and runs two jobs in PARALLEL: api (push "
              "the multi-arch image, `alembic upgrade head` as a one-off task BEFORE rolling the service) and web "
              "(publish the SPA, invalidate CloudFront). `cdk-deploy.yml` and `ops-task.yml` are human-dispatched "
              "only; `agent-release.yml` dispatches deploy only when `vars.AGENT_AUTODEPLOY` is true AND "
              "`tools/ci/release_gate.py` allows it.")
    push = wf.node("Push / PR on darshani8/reep-", "githubTrigger", 1, c0, gy + 220,
                   {"owner": {"__rl": True, "value": "darshani8", "mode": "name"},
                    "repository": {"__rl": True, "value": "reep-", "mode": "name"}, "events": ["push", "pull_request"]},
                   notes="main NOT protected yet: ruleset not applied", cred="githubApi")
    ci = wf.node("ci.yml · api · pii-gate · api-imports · web · cdk", "noOp", 1, c1, gy + 220,
                 notes="pytest, PII gate, imports, ng build, synth")
    rel = wf.node("agent-release.yml (release gate)", "noOp", 1, c2, gy + 100,
                  notes="migrations / infra / auth always need a human")
    dep = wf.node("deploy.yml", "noOp", 1, c2, gy + 340, notes="workflow_dispatch: api / web / both")
    oidc = wf.node("IAM OIDC -> role reep-github-deploy", "awsIam", 1, c3, gy + 340, {},
                   notes="ECR, ECS, PassRole, S3 SPA, CF, CE; CDK boot roles", cred="aws")
    api_steps = [
        ("ECR push reep/api:<sha> + :latest", "multi-arch; amd64 + arm64 asserted"),
        ("RunTask alembic upgrade head", "fails before the roll"),
        ("ECS update-service api", "circuit breaker + rollback"),
    ]
    web_steps = [
        ("S3 sync SPA reep-web", "index / ngsw / reep-sw no-cache"),
        ("CloudFront invalidation", "/, /index.html, /ngsw.json, /ngsw-worker.js, /reep-sw.js"),
    ]
    for row, chain in enumerate((api_steps, web_steps)):
        prev = oidc
        for i, (label, note) in enumerate(chain):
            name = wf.node(label, "noOp", 1, c3 + 300 + i * 0, gy + 200 + row * 520 + i * 170, {}, notes=note)
            wf.link(prev, name)
            prev = name
    wf.link(push, ci); wf.link(ci, rel); wf.link(rel, dep); wf.link(dep, oidc)
    others = [
        ("cdk-deploy.yml (human only)", "voice / edge-waf / dr-vault / core-9a / core-9b / NAT x2"),
        ("ops-task.yml (fixed task menu)", "purge-*, seed-*, grant-access as RunTask"),
        ("infra-drift.yml 08:00 IST", "cdk diff vs main + drift + cost; never deploys"),
        ("claude.yml / claude-review.yml", "@claude -> PR; review every non-draft PR"),
        ("agent-ops.yml -> agent-triage.yml", "drift, failed deploys, incidents"),
        ("agent-maintenance.yml Mondays", "dependency and drift sweep"),
    ]
    for i, (label, note) in enumerate(others):
        gh = wf.node(label, "github", 1.1, c0 + (i % 3) * 700, gy + 760 + (i // 3) * 240,
                {"resource": "repository", "operation": "get",
                 "owner": {"__rl": True, "value": "darshani8", "mode": "name"},
                 "repository": {"__rl": True, "value": "reep-", "mode": "name"}},
                notes=note, cred="githubApi")
        if label.startswith(("cdk-deploy", "ops-task", "infra-drift")):
            wf.link(gh, oidc)

    menu = inv.get("ops_task_menu", [])
    wf.sticky("Ops task menu", c0 + 2100, gy + 1180, 1700, 320, 7,
              "**`ops-task.yml` is a FIXED menu** (free text there would be RCE on the cluster): "
              + ", ".join(f"`{m}`" for m in menu)
              + ". Each runs `python -m app.<module>` as a one-off Fargate task on the api image; a purge also "
                "demands its own typed sentence (`DELETE EVERY STUDENT` for purge-students).")

    # ---- data model
    dy = gy + 1620
    tables = inv["tables"]
    by_dom: dict[str, list[str]] = defaultdict(list)
    for t in tables:
        by_dom[t["domain"]].append(t["table"])
    lines = ["## 7 · The data model: every table in RDS, by domain",
             f"{len(tables)} tables (`app/models/` plus migration-only tables); all but `alembic_version` carry a "
             "written verdict in `purge_people.VERDICTS`, so a new table nobody classified aborts both "
             "destructors.", "",
             "| Domain | Tables |", "|---|---|"]
    for dom in sorted(by_dom):
        lines.append(f"| **{dom}** ({len(by_dom[dom])}) | " + ", ".join(f"`{t}`" for t in sorted(by_dom[dom])) + " |")
    wf.sticky("Data model", x0, dy, W, 300 + 62 * len(by_dom), 7, "\n".join(lines))


def live_routes() -> set[tuple[str, str]]:
    """(method, path) for every route the FastAPI app serves, read from the app itself.

    Needs the API's dependencies importable (run it with apps/api-py's venv).
    FastAPI 0.141 keeps included routers nested, so the walk follows them."""
    import os

    sys.path.insert(0, str(ROOT / "apps" / "api-py"))
    os.environ.setdefault("ENV", "dev")
    os.environ.setdefault("AUTH_SECRET", "route-check-only-not-a-secret")
    os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://route:check@localhost:5433/none")
    from app.main import app  # noqa: PLC0415 -- only this mode needs the API importable

    found: set[tuple[str, str]] = set()

    def walk(routes, prefix=""):
        for route in routes:
            if type(route).__name__ == "_IncludedRouter":
                ctx = route.include_context
                walk(route.original_router.routes, prefix + (getattr(ctx, "prefix", "") or ""))
                continue
            endpoint = getattr(route, "endpoint", None)
            if endpoint is None or endpoint.__module__.startswith("fastapi"):
                continue
            methods = getattr(route, "methods", None) or ({"WS"} if "WebSocket" in type(route).__name__ else set())
            for method in methods - {"HEAD"}:
                found.add((method, prefix + route.path))

    walk(app.routes)
    return found


def check_routes(inv: dict) -> int:
    drawn = {(e["method"], e["path"]) for e in inv["endpoints"]}
    live = live_routes()
    missing, gone = sorted(live - drawn), sorted(drawn - live)
    for method, path in missing:
        print(f"NOT IN THE DIAGRAM  {method:<6} {path}")
    for method, path in gone:
        print(f"NO LONGER SERVED    {method:<6} {path}")
    print(f"{len(live)} live routes, {len(drawn)} drawn: "
          + ("in step" if not (missing or gone) else f"{len(missing)} missing, {len(gone)} stale"))
    return 1 if missing or gone else 0


def main() -> int:
    inv = json.loads(INVENTORY.read_text(encoding="utf-8"))
    if "--check-routes" in sys.argv[1:]:
        return check_routes(inv)
    endpoints = inv["endpoints"]
    route_roles = {r["path"]: set(r["roles"]) for r in inv["routes"]}
    lanes, grants = build_lanes(endpoints)
    feature_count = sum(len(f) for groups in lanes.values() for f in groups.values()) + len(grants)

    wf = Workflow()
    role_sw, sw_x, edge = render_request_path(wf, -4300, 1780)
    render_left(wf, -4500, 0, inv,
                {"endpoints": len(endpoints), "features": feature_count}, edge)

    lx, top = max(sw_x + 700, 400), 0
    order = ["PUBLIC", "ACCOUNT", "STUDENT", "FACULTY", "ALUMNI", "MAIN_ADMIN"]
    outputs = {"PUBLIC": 0, "ACCOUNT": 1, "STUDENT": 2, "FACULTY": 3, "ALUMNI": 4, "MAIN_ADMIN": 5}
    for lane in order:
        groups = lanes[lane]
        if lane == "MAIN_ADMIN":
            # Two side-by-side halves, both fed by the one MAIN ADMIN output.
            items = list(groups.items())
            sizes = [sum(len(eps) for eps in feats.values()) + 3 * len(feats) for _, feats in items]
            half, acc, cut = sum(sizes) / 2, 0, len(items)
            for i, s in enumerate(sizes):
                acc += s
                if acc >= half:
                    cut = i + 1
                    break
            for part, chunk in enumerate([items[:cut], items[cut:]]):
                entry, _bottom, width = render_lane(wf, lane, OrderedDict(chunk), lx, top, route_roles,
                                                    title_suffix=f" ({part + 1} of 2)")
                wf.link(role_sw, entry, outputs[lane])
                lx += width + 400
            continue
        entry, _bottom, width = render_lane(wf, lane, groups, lx, top, route_roles,
                                            grants=grants if lane == "FACULTY" else None)
        wf.link(role_sw, entry, outputs[lane])
        lx += width + 400

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(wf.to_json(), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    kinds = Counter(n["type"].split(".")[-1] for n in wf.nodes)
    print(f"wrote {OUT.relative_to(ROOT)}: {len(wf.nodes)} nodes "
          f"({kinds['stickyNote']} stickies, {kinds['httpRequest']} HTTP, {kinds['switch']} switches), "
          f"{sum(len(v['main']) for v in wf.connections.values())} source outputs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
