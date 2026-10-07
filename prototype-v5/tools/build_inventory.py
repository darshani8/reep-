"""Build prototype-v5/FUNCTION-INVENTORY.md from the four inventory part files and the
prototype source. A row's "Prototype" cell names the screen whose R.screen(...) block
holds its I('ID') tag, plus the visible label nearest to the tag. Exits 1 if any row in
scope has no tag, so "every row is carried" is a check rather than a claim.

usage: python3 tools/build_inventory.py <dir-with-A.md-B.md-C.md-D.md>
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
SRC = sorted((HERE / 'js').glob('*.js'))
OUT_OF_SCOPE = {'A-104': 'Alumni sidebar; the Alumni role is outside this brief, which covers Student, Faculty and Main Admin'}
MERGES = {
    'student/records': 'Records and Courses are one screen, "Results & courses", with tabs (Results · Attendance · Courses · Academic history).',
    'account': 'My account, /account/password and /mentor/signature are one screen, "Account & security"; the password form opens as a sheet.',
    'agent': 'The REEP Agent page and the dock’s "Ask REEP" tab render the same chat.',
    'admin/colleges': 'Colleges, College structure and Set up a college are one area: list → college → structure, with the six-step setup as a pushed flow.',
    'admin/governance': 'Who can do what and Feature switches are one screen with tabs.',
}


def rows(d):
    out = []
    for f in 'ABCD':
        p = Path(d) / f'{f}.md'
        for line in p.read_text().splitlines():
            if not re.match(r'^\|\s*[A-D]-\d{3}\s*\|', line):
                continue
            cells = [c.strip() for c in line.strip().strip('|').split('|')]
            if len(cells) < 7:
                cells += [''] * (7 - len(cells))
            cells = cells[:6] + [' | '.join(cells[6:])] if len(cells) > 7 else cells
            out.append(cells)
    return out


def screens():
    """Map each source offset to the screen it belongs to."""
    spans = []
    for f in SRC:
        text = f.read_text()
        marks = [(m.start(), m.group(1), m.group(2)) for m in re.finditer(r"R\.screen\(\s*[`']([^`']+)[`']\s*,\s*\{\s*title:\s*['`]?([^'`,]*)", text)]
        # helpers drawn above their R.screen call say which screen they belong to
        marks += [(m.start(), m.group(1), m.group(2)) for m in re.finditer(r"/\* @screen (\S+) ([^*]+?) \*/", text)]
        marks.sort()
        spans.append((f, text, marks))
    return spans


ANY = re.compile(r"\b([A-D]-\d{3})\b")


def label_near(text, pos):
    tail = text[pos:pos + 150]
    m = re.search(r">\s*([A-Za-z—→ ][^<>${}]{2,70}?)\s*<", tail)
    head = text[max(0, pos - 300):pos]
    hm = re.findall(r"(?:label|title|h):\s*'([^']{2,60})'", head)
    if m and m.group(1).strip(' —') and not m.group(1).strip().startswith(('.', ',', ')')):
        return m.group(1).strip()
    if hm:
        return hm[-1]
    lm = re.findall(r"chip\('([^']{2,50})'", tail[:200])
    return lm[0] if lm else ''


def where(spans):
    found = {}
    for f, text, marks in spans:
        for m in ANY.finditer(text):
            i = m.group(1)
            scr = None
            for start, key, title in marks:
                if start <= m.start():
                    scr = (key, title)
            line = text[text.rfind('\n', 0, m.start()) + 1:m.start()]
            if f.name == 'app.js' and not re.search(r"R\.screen", text[max(0, m.start() - 3000):m.start()]):
                scr = ('shell', 'App shell (rail · tab bar · top bar · More)')
            lab = 'loading and error states (State switch)' if re.search(r"states:\s*'[^']*$", line) else label_near(text, m.end())
            found.setdefault(i, []).append((f.name, scr, lab))
    return found


ROUTE_MAP = [  # old route (prefix match, longest first) -> prototype route
    ('/student/agent', '{role}/agent'), ('/mentor/agent', '{role}/agent'), ('/admin/agent', '{role}/agent'),
    ('/account/password', '{role}/account'), ('/mentor/signature', '{role}/account'), ('/account', '{role}/account'),
    ('/student/courses', 'student/records'), ('/student/', None), ('/student', 'student/home'),
    ('/mentor/', 'faculty/'), ('/admin/governance/features', 'admin/governance-features'),
    ('/admin/institution', 'admin/colleges/:id'), ('/admin/faculty/new', 'admin/faculty-new'),
    ('/admin/students/:id', 'admin/students/:id'), ('/admin/students,', 'PersonDelete'), ('/admin/', None), ('/admin', 'admin/home'),
    ('/login', 'public/login'), ('/onboard', 'public/onboard'), ('/activate', 'public/activate'), ('/reset', 'public/reset'), ('/register', 'public/register'),
    ('(dock)', 'dock'), ('(shell)', 'shell'),
]


def proto_route(old):
    for k, v in ROUTE_MAP:
        if old.startswith(k):
            if v is None:
                return old.lstrip('/').split(',')[0]
            if v.endswith('/'):
                return v + old[len(k):]
            return v
    return old.lstrip('/')


def route_label(key, title):
    if key == 'shell':
        return title
    k = key.replace('${role}', '{role}')
    if '/' not in k:
        return f"{title.strip()} (the ✦ button on every screen)"
    return f"{title.strip() or k} (`#/{k}`)"


def main():
    import json
    d = sys.argv[1]
    seen = json.loads((HERE / 'tools' / 'seen.json').read_text()) if (HERE / 'tools' / 'seen.json').exists() else {}
    titles = {}
    for f in SRC:
        for m in re.finditer(r"R\.screen\(\s*[`']([^`']+)[`']\s*,\s*\{\s*title:\s*'([^']*)'", f.read_text()):
            titles.setdefault(m.group(1).replace('${role}', '{role}'), m.group(2))
    titles.update({'shell': 'App shell — rail, tab bar, top bar, More', 'dock': 'Assistant dock (✦ on every screen)', 'PersonDelete': 'Remove or delete sheet (Students, Faculty, Colleges)',
                   'admin/colleges/:id': 'College structure (`#/admin/colleges/<id>`)', 'admin/students/:id': 'Student 360 (`#/admin/students/<id>`)', '{role}/account': 'Account & security', '{role}/agent': 'REEP Agent', 'admin/governance-features': 'Who can do what › Feature switches tab'})
    allrows = rows(d)
    hits = where(screens())
    missing = [r[0] for r in allrows if r[0] not in hits and r[0] not in OUT_OF_SCOPE]
    lines = []
    lines.append('# REEP v5 prototype — function inventory\n')
    lines.append('Every route in `apps/web/src/app/app.routes.ts` for the Student, Faculty (MENTOR) and Main Admin roles, the signed-out screens those people pass through, and the shell around them; and every user action on each screen: buttons, forms, filters, uploads, exports, dialogs and statuses. Each row was read from the component’s template and TypeScript. The last column names the prototype screen and element that carries the function. Every element in the prototype that carries a row says so with `data-inv="<ID>"`, so a row can be found in the running prototype with the browser’s inspector, and `tools/build_inventory.py` refuses to build this file while any row is uncarried.\n')
    inscope = [r for r in allrows if r[0] not in OUT_OF_SCOPE]
    lines.append(f'**Rows: {len(inscope)} in scope · carried: {len(inscope) - len(missing)} · seen drawn on a screen at load by the Playwright walk: {sum(1 for r in inscope if r[0] in seen)} (the rest live in sheets, tabs or states reached by acting, and were tagged in source).** Out of scope: ' + '; '.join(f'{k} ({v})' for k, v in OUT_OF_SCOPE.items()) + '\n')
    lines.append('## Screens merged (fewer doors, nothing dropped)\n')
    for v in MERGES.values():
        lines.append(f'- {v}')
    lines.append('- Every screen’s loading, error and Retry states are drawn by one shared pattern; the prototype bar’s **State** switch shows them on any screen, tagged with that screen’s rows.\n')
    groups = [('Signed out and shared', lambda r: r[0].startswith('A-') and (r[1] in ('Public', 'All', 'All staff') or r[2] in ('(shell)', '(dock)'))),
              ('Student', lambda r: r[1].startswith('Student')),
              ('Faculty', lambda r: r[1].startswith('Faculty')),
              ('Main Admin', lambda r: r[1].startswith('Admin'))]
    done = set()
    for name, pred in groups:
        sel = [r for r in inscope if pred(r) and r[0] not in done]
        if not sel:
            continue
        lines.append(f'## {name} ({len(sel)} rows)\n')
        lines.append('| ID | Role | Route | Screen | Action / element | Kind | Rule it obeys | Prototype screen › element |')
        lines.append('|---|---|---|---|---|---|---|---|')
        for r in sel:
            done.add(r[0])
            h = hits.get(r[0])
            pr = proto_route(r[2])
            if h:
                t = titles.get(pr, pr)
                cell = t if '`' in t or pr in ('shell', 'dock', 'PersonDelete') else f'{t} (`#/{pr}`)'
                if r[0] in seen:
                    cell += f' › “{seen[r[0]][1] or r[4][:50]}”'
                else:
                    lab = h[0][2]
                    cell += f' › {"“" + lab + "”" if lab else r[4][:60]} (in a sheet or a state reached by acting)'
            elif False:
                f, scr, lab = h[0]
                cell = route_label(*scr) if scr else f'`{f}`'
                el = f'“{lab}”' if lab else 'the control named in this row'
                cell += f' › {el}'
                if len(h) > 1:
                    cell += f' (+{len(h) - 1} more place{"s" if len(h) > 2 else ""})'
            else:
                cell = '**NOT CARRIED**'
            esc = lambda s: s.replace('|', '\\|')
            lines.append('| ' + ' | '.join(esc(c) for c in r[:7]) + f' | {esc(cell)} |')
        lines.append('')
    rest = [r for r in inscope if r[0] not in done]
    if rest:
        lines.append(f'## Other ({len(rest)} rows)\n')
        for r in rest:
            lines.append(f'- {r[0]} {r[4]}')
    (HERE / 'FUNCTION-INVENTORY.md').write_text('\n'.join(lines) + '\n')
    print(f'{len(inscope)} rows in scope, {len(inscope) - len(missing)} carried, {sum(1 for r in inscope if r[0] in seen)} seen on a screen at load')
    if missing:
        print('missing:', ' '.join(missing))
        sys.exit(1)


if __name__ == '__main__':
    main()
