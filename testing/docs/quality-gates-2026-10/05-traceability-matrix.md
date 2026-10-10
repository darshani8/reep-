# 05 — Requirements Traceability Matrix: Quality Gates release (QG-2026-10)

| Field | Value |
|---|---|
| Document ID | REEP-RTM-QG-2026-10 |
| Version | 1.0 |
| Status | Final for the build under review |
| Standard followed | ISO/IEC/IEEE 29119-3:2021 (traceability between test basis, test cases and results) |
| Test basis | [01 — Test Plan](01-test-plan.md) §2, REEP-TP-QG-2026-10 v1.1: 37 requirements |
| Sources | [02](02-unit-testing.md) v1.2, [03](03-integration-testing.md) v1.4, [04](04-system-testing.md) v1.1 |
| Prepared by | the orchestrating session (Test Manager role), 2026-10-08 |

### Revision history

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-08 | Generated from the final level documents after the last re-test rounds |

---

## 1. How this matrix is built, and how to rebuild it

It is **generated, not typed**, so it cannot drift from the level documents. `testing/tools/qg_traceability.py` reads:

* the requirement list from the plan;
* each level's case index (§4, including cases added in re-test rounds) and its §7 coverage tables, for which cases verify which requirement;
* every verdict the tester recorded, on the case itself and in the execution and re-test logs (§5, §5a, §5b). **The last recorded verdict wins**, so a case that failed in round 1 and passed on re-test reads Pass.

Cases that end not passed are explained from `traceability-dispositions.json`. To rebuild, from `testing/docs/quality-gates-2026-10/`:

```
python3 ../../tools/qg_traceability.py 01-test-plan.md 02-unit-testing.md \
    03-integration-testing.md 04-system-testing.md traceability-dispositions.json
```

## 2. Summary

| Measure | Value |
|---|---|
| Requirements in the test basis | 37 |
| Requirements covered by at least one executed case | **37 (100 %)** |
| Requirements whose every case finally passed | 31 |
| Requirements with a not-passed case | 6, each explained in §4; none by an open Critical or Major defect |
| Distinct cases with a final verdict | 241 (L1 147, L2 54, L3 40) |
| Cases whose final verdict is not Pass | 5: four tied to the deferred Minor defects (Q5), one upstream gitleaks behaviour (OBS-QG-U08) |

Executions are counted separately in the [Test Completion Report](07-test-completion-report.md): many cases ran two or three times across rounds.

## 3. The matrix

A dash means the level did not test that requirement by design. Plan §3 assigns each requirement to the level that can observe it; for example, REQ-G3-09 (the OpenAPI document is unchanged) is visible only to the system level.

| Requirement | L1 unit | L2 integration | L3 system | Cases | Final verdict |
|---|---|---|---|---|---|
| REQ-G1-01 | UT-G1-000, UT-G1-001, UT-G1-002, UT-G1-003, UT-G1-004, UT-G1-005, UT-G1-006, UT-G1-007, UT-G1-008, UT-G1-009, UT-G1-011, UT-G1-012 | IT-G1-003 | — | 13 | **Pass** |
| REQ-G1-02 | UT-G1-009, UT-G1-010, UT-G1-036, UT-G1-037, UT-G1-038, UT-G1-039, UT-G1-040, UT-G1-041, UT-G1-042, UT-G1-043 | — | — | 10 | Pass, except UT-G1-040 (Fail: DEF-QG-U12, deferred (proposed), Q5) |
| REQ-G1-03 | UT-G1-000, UT-G1-014, UT-G1-015, UT-G1-016, UT-G1-017, UT-G1-018, UT-G1-019, UT-G1-020 | IT-G1-003, IT-GX-019 | — | 10 | **Pass** |
| REQ-G1-04 | UT-G1-000, UT-G1-022, UT-G1-023, UT-G1-024, UT-G1-025, UT-G1-026, UT-G1-027, UT-G1-028, UT-G1-029, UT-G1-030, UT-G1-035 | IT-G1-003 | — | 12 | **Pass** |
| REQ-G1-05 | UT-G1-031, UT-G1-032, UT-G1-033, UT-G1-034 | — | — | 4 | **Pass** |
| REQ-G1-06 | — | IT-G1-001, IT-G1-002, IT-G1-003, IT-G1-004 | — | 4 | **Pass** |
| REQ-G1-07 | UT-G1-021 | IT-G1-002 | — | 2 | **Pass** |
| REQ-G2-01 | UT-G2-020 | IT-G2-008, IT-G2-009 | — | 3 | **Pass** |
| REQ-G2-02 | — | IT-G2-001, IT-G2-005, IT-G2-006, IT-G2-013 | — | 4 | **Pass** |
| REQ-G2-03 | — | IT-G2-002, IT-G2-003 | — | 2 | **Pass** |
| REQ-G2-04 | — | IT-G2-004, IT-G2-013 | — | 2 | **Pass** |
| REQ-G2-05 | UT-G2-001, UT-G2-002, UT-G2-003, UT-G2-004, UT-G2-005, UT-G2-006, UT-G2-007, UT-G2-008, UT-G2-009, UT-G2-010, UT-G2-011, UT-G2-013, UT-G2-014, UT-G2-016, UT-G2-017, UT-G2-021, UT-G2-022, UT-G2-023, UT-G2-024, UT-G2-025, UT-G2-026, UT-G2-027 | IT-G2-007, IT-G2-010, IT-G2-012, IT-GX-024 | — | 26 | Pass, except UT-G2-025 (Fail: OBS-QG-U08: upstream gitleaks rule boundary, not a defect of this change) |
| REQ-G2-06 | UT-G2-012 | IT-G2-002, IT-G2-011, IT-GX-014, IT-GX-016 | ST-039 | 6 | **Pass** |
| REQ-G2-07 | — | IT-G2-007, IT-GX-001, IT-GX-002, IT-GX-003, IT-GX-006, IT-GX-007, IT-GX-008 | — | 7 | **Pass** |
| REQ-G2-08 | UT-G2-018 | IT-G2-006 | ST-034, ST-035 | 4 | **Pass** |
| REQ-G3-01 | UT-G3-000, UT-G3-028 | IT-G3-001 | — | 3 | **Pass** |
| REQ-G3-02 | UT-G3-000, UT-G3-001, UT-G3-024 | IT-G3-002 | — | 4 | **Pass** |
| REQ-G3-03 | UT-G3-000, UT-G3-002, UT-G3-003, UT-G3-004, UT-G3-005, UT-G3-006, UT-G3-007, UT-G3-008, UT-G3-009, UT-G3-029, UT-G3-030, UT-G3-031, UT-G3-032, UT-G3-033, UT-G3-034, UT-G3-035, UT-G3-036, UT-G3-037, UT-G3-038, UT-G3-041, UT-G3-042, UT-G3-043, UT-G3-044, UT-G3-045, UT-G3-046, UT-G3-047, UT-G3-048, UT-G3-049, UT-G3-050 | — | — | 29 | Pass, except UT-G3-050 (Fail: DEF-QG-U13, deferred (proposed), Q5) |
| REQ-G3-04 | UT-G3-000, UT-G3-010, UT-G3-011, UT-G3-012, UT-G3-013, UT-G3-014, UT-G3-015, UT-G3-016, UT-G3-039, UT-G3-040 | IT-G3-002 | — | 11 | **Pass** |
| REQ-G3-05 | UT-G3-000, UT-G3-017, UT-G3-018, UT-G3-019 | — | — | 4 | **Pass** |
| REQ-G3-06 | UT-G3-000, UT-G3-020, UT-G3-021, UT-G3-022, UT-G3-023 | — | — | 5 | **Pass** |
| REQ-G3-07 | UT-G3-000, UT-G3-025, UT-G3-026 | — | — | 3 | **Pass** |
| REQ-G3-08 | UT-G3-027 | IT-G3-001 | — | 2 | **Pass** |
| REQ-G3-09 | — | — | ST-007, ST-033 | 2 | **Pass** |
| REQ-G4-01 | UT-G3-000, UT-G4-001, UT-G4-002, UT-G4-003, UT-G4-004, UT-G4-005, UT-G4-006, UT-G4-007, UT-G4-015, UT-G4-024, UT-G4-026 | IT-G4-004, IT-G4-005, IT-G4-007 | — | 14 | Pass, except UT-G4-026 (Fail: DEF-QG-U14, deferred (proposed), Q5) |
| REQ-G4-02 | UT-G4-010 | IT-G1-001, IT-G4-001, IT-G4-002, IT-G4-003, IT-G4-007 | ST-002 | 7 | **Pass** |
| REQ-G4-03 | UT-G4-011, UT-G4-012, UT-G4-013, UT-G4-014, UT-G4-016, UT-G4-023 | IT-G4-004, IT-G4-005, IT-G4-006 | — | 9 | **Pass** |
| REQ-G4-04 | UT-G4-017, UT-G4-018, UT-G4-019, UT-G4-020, UT-G4-021, UT-G4-022, UT-G4-025 | IT-G4-008 | — | 8 | **Pass** |
| REQ-G4-05 | — | IT-G1-001, IT-G1-002, IT-G4-001 | ST-002 | 4 | **Pass** |
| REQ-G4-06 | — | IT-G4-009, IT-G4-010, IT-GX-011, IT-GX-018 | — | 4 | **Pass** |
| REQ-G5-01 | UT-G5-001 | — | — | 1 | **Pass** |
| REQ-G5-02 | UT-G5-002 | — | — | 1 | **Pass** |
| REQ-G5-03 | — | — | ST-036, ST-037 | 2 | **Pass** |
| REQ-GX-01 | — | IT-G1-002, IT-GX-001, IT-GX-002, IT-GX-004, IT-GX-005, IT-GX-007, IT-GX-008, IT-GX-009, IT-GX-010, IT-GX-022 | ST-037, ST-038 | 12 | Pass, except IT-GX-022 (Fail: DEF-QG-I05, deferred (proposed), Q5) |
| REQ-GX-02 | UT-GX-001, UT-GX-002 | IT-GX-005, IT-GX-011, IT-GX-012, IT-GX-013, IT-GX-014, IT-GX-015, IT-GX-016, IT-GX-017, IT-GX-018, IT-GX-019, IT-GX-020, IT-GX-021, IT-GX-022, IT-GX-023, IT-GX-024, IT-GX-025 | — | 18 | Pass, except IT-GX-022 (Fail: DEF-QG-I05, deferred (proposed), Q5) |
| REQ-GX-03 | — | IT-G1-001, IT-GX-011 | ST-001, ST-004, ST-005, ST-007, ST-008, ST-009, ST-010, ST-011, ST-012, ST-013, ST-014, ST-015, ST-024, ST-025, ST-026, ST-027, ST-029, ST-030, ST-031, ST-032, ST-033, ST-038, ST-040 | 25 | **Pass** |
| REQ-GX-04 | — | — | ST-001, ST-002, ST-003, ST-004, ST-006, ST-012, ST-013, ST-014, ST-015, ST-016, ST-017, ST-018, ST-019, ST-020, ST-021, ST-022, ST-023, ST-024, ST-025, ST-026, ST-028 | 21 | **Pass** |

## 4. Cases whose final verdict is not Pass

| Case | Requirement(s) | Final verdict | Disposition |
|---|---|---|---|
| UT-G1-040 | REQ-G1-02 | Fail | DEF-QG-U12 (Minor): a reasoned `ruff: disable`…`enable` range spanning a whole module. Deferred (proposed), awaiting Q5 |
| UT-G3-050 | REQ-G3-03 | Fail | DEF-QG-U13 (Minor): a caught exception class rebound to a local name. Deferred (proposed), awaiting Q5 |
| UT-G4-026 | REQ-G4-01 | Fail | DEF-QG-U14 (Minor): a `return` inside a constant-true branch of a downgrade. Deferred (proposed), awaiting Q5 |
| IT-GX-022 | REQ-GX-01, REQ-GX-02 | Fail | DEF-QG-I05 (Minor): a preflight check call behind `if false` or after `exit 0` still satisfies §34. Deferred (proposed), awaiting Q5 |
| UT-G2-025 | REQ-G2-05 | Fail | OBS-QG-U08: gitleaks' own `openai-api-key` rule stops at `<`, so a key inside an HTML element is not reported. Upstream behaviour, identical with no REEP configuration; REEP's `reep-openai-key` still catches the `OPENAI_API_KEY=` assignment form. Not a defect of this change |

All four deferred defects are tracked as one follow-up task. The full incident lifecycle is in [06 — Incident register](06-incident-register.md).
