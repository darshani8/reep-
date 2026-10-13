"""Production-safe retest of the multi-college fixes. WRITES NOTHING.

    python3 testing/api/prod_smoke_negative.py [https://reep.sast-skills.com]

Every /register probe omits the CV and the photo, so the request is refused at
the schema with 422 before the handler runs, on the old code and the new alike.
What tells the two apart is the error LIST: pydantic reports every refused
field together, so the fixed build also names `name` (blank) or `phone`
(not a number) beside the two missing files. No application can be created,
whichever build answers. The rest are anonymous reads that must be refused.
"""
import json
import sys
import urllib.request
import uuid

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://reep.sast-skills.com").rstrip("/")
RESULTS = []


def call(method, path, data=None, ctype=None):
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if ctype:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def multipart(fields):
    b = uuid.uuid4().hex
    body = "".join(f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n' for k, v in fields.items())
    return (body + f"--{b}--\r\n").encode(), f"multipart/form-data; boundary={b}"


def refused_fields(text):
    try:
        return sorted({e["loc"][-1] for e in json.loads(text)["detail"]})
    except Exception:
        return []


base = {"name": "Smoke Probe", "email": f"smoke{uuid.uuid4().hex[:6]}@example.invalid", "usn": "1SMOKE0001",
        "phone": "+91 98765 43210", "personal_email": "smoke.probe@example.invalid",
        "linkedin_url": "linkedin.com/in/smoke-probe", "degree_level": "UG"}

for label, override, field in (("blank name", {"name": "   "}, "name"),
                               ("phone is words", {"phone": "call me maybe"}, "phone")):
    body, ctype = multipart({**base, **override})
    status, text = call("POST", "/api/register", body, ctype)
    fields = refused_fields(text)
    RESULTS.append((f"register: {label} refused", status == 422 and field in fields, f"{status} {fields}"))

body, ctype = multipart(base)
status, text = call("POST", "/api/register", body, ctype)
fields = refused_fields(text)
RESULTS.append(("register: control (valid fields, no files) names only the files",
                status == 422 and fields == ["cv", "photo"], f"{status} {fields}"))

status, text = call("GET", "/api/register/hierarchy")
blank = 0
if status == 200:
    doc = json.loads(text)
    for c in doc.get("colleges", []):
        blank += not (c.get("name") or "").strip()
        blank += sum(1 for d in c.get("departments", []) if not (d.get("name") or "").strip())
RESULTS.append(("public form offers no blank college or department", status == 200 and blank == 0, f"{status} blank={blank}"))

for path in ("/api/admin/colleges", "/api/register/pending", "/api/student/uploads", "/api/mentor/mentees", "/api/admin/audit"):
    status, _ = call("GET", path)
    RESULTS.append((f"anonymous GET {path} refused", status in (401, 403), str(status)))

ok = sum(1 for _, passed, _ in RESULTS if passed)
for name, passed, detail in RESULTS:
    print(("PASS " if passed else "FAIL ") + f"{name}  [{detail}]")
print(f"{ok}/{len(RESULTS)} passed against {BASE}")
sys.exit(0 if ok == len(RESULTS) else 1)
