"""The core stack synthesises in both phases, and the template has the shape
the cutover depends on.

These are the guards that make `cdk import` safe to run against live student
data. Each pins a property that, if it drifted, would either make the import
fail (a mismatched physical name) or make the first deploy after it destroy
something (a master password, a replaced security group).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import aws_cdk as cdk
import pytest
from aws_cdk.assertions import Match, Template

from reep_core import DEREGISTRATION_DELAY_SECONDS, STOP_TIMEOUT_SECONDS, CoreStack, DrVaultStack, EdgeWafStack

TF_DIR = Path(__file__).resolve().parents[2] / "aws"

#: The guards that read the .tf files are for the coexistence window. Step 7
#: of docs/cdk-cutover.md deletes those files; from then on the mirror is the
#: only record and these tests skip rather than fail the cutover commit.
requires_terraform = pytest.mark.skipif(
    not list(TF_DIR.glob("*.tf")),
    reason="Terraform released (docs/cdk-cutover.md step 7); the mirror is now the only record",
)


CDK_JSON_CONTEXT = json.loads((Path(__file__).resolve().parents[1] / "cdk.json").read_text(encoding="utf-8"))["context"]


def _core(phase: str, **context: object) -> Template:
    # cdk.json's context is loaded the way the CLI loads it, feature flags and
    # harden targets included — the import phase must stay correct WITH them.
    app = cdk.App(context={**CDK_JSON_CONTEXT, "phase": phase, **context})
    stack = CoreStack(app, "test-core", project="reep", env=cdk.Environment(account="123456789012", region="ap-south-1"))
    return Template.from_stack(stack)


@pytest.fixture(scope="module")
def imported() -> Template:
    return _core("import")


@pytest.fixture(scope="module")
def hardened() -> Template:
    return _core(
        "harden",
        wafWebAclArn="arn:aws:wafv2:us-east-1:123456789012:global/webacl/reep-edge/abc",
        drVaultArn="arn:aws:backup:ap-southeast-1:123456789012:backup-vault:reep-vault-dr",
        sesIdentityDomain="bgscet.ac.in",
        sesFromAddress="reep@bgscet.ac.in",
        alertEmail="ops@bgscet.ac.in",
    )


# ------------------------------------------------------- the two phases --


def test_both_phases_synthesise(imported: Template, hardened: Template) -> None:
    assert imported.to_json()["Resources"]
    assert hardened.to_json()["Resources"]


def test_import_phase_adds_nothing_the_import_cannot_adopt(imported: Template) -> None:
    """`cdk import` refuses a template whose diff creates non-imported
    resources. Custom resources (cross-region references, log-retention
    helpers, OIDC L2) are exactly that, and none may appear."""
    types = {r["Type"] for r in imported.to_json()["Resources"].values()}
    forbidden = {t for t in types if t.startswith("Custom::") or t == "AWS::CloudFormation::CustomResource" or t.startswith("AWS::Lambda::")}
    assert not forbidden, f"import-hostile resources in the import phase: {sorted(forbidden)}"


def test_import_phase_is_a_strict_subset_of_harden(imported: Template, hardened: Template) -> None:
    """Everything the import adopts is still there after hardening, under the
    same logical id — so the second deploy updates in place and replaces
    nothing."""
    imp = set(imported.to_json()["Resources"])
    hard = set(hardened.to_json()["Resources"])
    assert imp <= hard, f"import-phase resources missing from harden: {sorted(imp - hard)}"
    added = sorted(hard - imp)
    assert added, "harden must add something, or it is not a hardening"


# ------------------------------------------------- the one fatal property --


def test_no_master_password_in_the_template(imported: Template, hardened: Template) -> None:
    """A MasterUserPassword here would rotate the live database's password
    under the running api. It must never appear, in either phase."""
    for t in (imported, hardened):
        for res in t.to_json()["Resources"].values():
            if res["Type"] == "AWS::RDS::DBInstance":
                props = res.get("Properties", {})
                assert "MasterUserPassword" not in props
                assert "ManageMasterUserPassword" not in props
                assert props["MasterUsername"] == "reep"
                assert props["DBInstanceIdentifier"] == "reep-postgres"
                assert props["DeletionProtection"] is True
                # Retain, NOT Snapshot: Snapshot means delete-after-snapshot, and
                # a delete-stack would then call DeleteDBInstance.
                assert res.get("DeletionPolicy") == "Retain"
                assert res.get("UpdateReplacePolicy") == "Retain"


# -------------------------------------------------------- physical names --

#: Names the Terraform files declare and an import must present verbatim.
#: Read from the .tf files rather than typed twice, so the guard cannot agree
#: with a stale copy of itself.
_TF_NAME_PATTERNS = [
    (r'family\s*=\s*"\$\{var\.project\}-api"', "reep-api"),
    (r'name\s*=\s*"\$\{var\.project\}-api-task"', "reep-api-task"),
    (r'name\s*=\s*"\$\{var\.project\}-task-execution"', "reep-task-execution"),
    (r'name\s*=\s*"\$\{var\.project\}-github-deploy"', "reep-github-deploy"),
    (r'name\s*=\s*"\$\{var\.project\}-scheduler"', "reep-scheduler"),
    (r'name\s*=\s*"\$\{var\.project\}-backup"', "reep-backup"),
    (r'name\s*=\s*"\$\{var\.project\}-claude-observer"', "reep-claude-observer"),
    (r'name\s*=\s*"\$\{var\.project\}-vault"', "reep-vault"),
    (r'name\s*=\s*"\$\{var\.project\}-daily"', "reep-daily"),
    (r'identifier\s*=\s*"\$\{var\.project\}-postgres"', "reep-postgres"),
    (r'name\s*=\s*"\$\{var\.project\}-alb"', "reep-alb"),
    (r'name\s*=\s*"/reep/api"', "/reep/api"),
    (r'name\s*=\s*"\$\{var\.project\}-alerts"', "reep-alerts"),
    (r'name\s*=\s*"\$\{var\.project\}/api"', "reep/api"),
    (r'name\s*=\s*"\$\{var\.project\}-retention-daily"', "reep-retention-daily"),
    (r'name\s*=\s*"\$\{var\.project\}-spa-fallback"', "reep-spa-fallback"),
    (r'name\s*=\s*"interview-dropped-turns"', "interview-dropped-turns"),
    (r'name\s*=\s*"cpu-target"', "cpu-target"),
    (r'name\s*=\s*"memory-target"', "memory-target"),
]


@requires_terraform
@pytest.mark.parametrize("pattern, expected", _TF_NAME_PATTERNS, ids=[e for _, e in _TF_NAME_PATTERNS])
def test_physical_names_match_terraform(imported: Template, pattern: str, expected: str) -> None:
    tf_text = "\n".join(p.read_text(encoding="utf-8") for p in TF_DIR.glob("*.tf"))
    assert re.search(pattern, tf_text), f"the Terraform files no longer declare {expected!r}; update both sides deliberately"
    assert expected in json.dumps(imported.to_json()), f"{expected!r} is in Terraform but not in the import-phase template"


@requires_terraform
def test_alarm_names_match_terraform(imported: Template) -> None:
    tf_text = (TF_DIR / "observability.tf").read_text(encoding="utf-8")
    tf_alarms = {m.replace("${var.project}", "reep") for m in re.findall(r'alarm_name\s*=\s*"([^"]+)"', tf_text)}
    cdk_alarms = {r["Properties"]["AlarmName"] for r in imported.to_json()["Resources"].values() if r["Type"] == "AWS::CloudWatch::Alarm"}
    assert tf_alarms == cdk_alarms, f"terraform={sorted(tf_alarms)} cdk={sorted(cdk_alarms)}"


def test_network_is_the_terraform_layout(imported: Template) -> None:
    imported.has_resource_properties("AWS::EC2::VPC", {"CidrBlock": "10.42.0.0/16"})
    for cidr in ("10.42.0.0/20", "10.42.16.0/20", "10.42.128.0/20", "10.42.144.0/20"):
        imported.has_resource_properties("AWS::EC2::Subnet", {"CidrBlock": cidr})
    imported.resource_count_is("AWS::EC2::NatGateway", 1)


# ------------------------------------------------------- the hardening --


def test_stop_timeout_is_fargates_maximum(hardened: Template) -> None:
    """120 is the ceiling Fargate enforces; the first plan wanted 500 and
    would have been refused. What protects a 480 s interview is the
    deregistration delay below, not this."""
    assert STOP_TIMEOUT_SECONDS == 120
    hardened.has_resource_properties(
        "AWS::ECS::TaskDefinition",
        {"ContainerDefinitions": Match.array_with([Match.object_like({"Name": "api", "StopTimeout": 120})])},
    )


def test_deregistration_delay_outlasts_an_interview(hardened: Template) -> None:
    assert DEREGISTRATION_DELAY_SECONDS >= 480 + 90
    hardened.has_resource_properties(
        "AWS::ElasticLoadBalancingV2::TargetGroup",
        {"TargetGroupAttributes": Match.array_with([{"Key": "deregistration_delay.timeout_seconds", "Value": str(DEREGISTRATION_DELAY_SECONDS)}])},
    )


def test_old_task_survives_until_the_new_one_is_healthy(hardened: Template) -> None:
    hardened.has_resource_properties(
        "AWS::ECS::Service",
        {"DeploymentConfiguration": Match.object_like({"MinimumHealthyPercent": 100, "MaximumPercent": 200})},
    )


def test_the_service_keeps_both_tasks_in_every_phase(imported: Template, hardened: Template) -> None:
    """INCIDENT (2026-09-07, the pre-import review, before any import ran):
    this property was written `100 if harden_ecs else 50`, on the assumption
    that 50 was live and 100 the improvement. **Live is already 100** —
    `ecs.tf` never sets it, so 100 is the ECS default. Rendering 50 in the
    import mirror would have produced a drift row at step 5, the checkpoint
    whose entire job is to be empty; and step 9a, which still updates this
    service to flip its ManagedBy tag, would have sent 50 to the live service
    for the length of the Multi-AZ conversion.

    The database's live values are pinned by
    `test_import_phase_carries_the_live_database_values_not_the_harden_targets`.
    Nothing pinned the ECS half. This is that guard: the number is the same in
    both phases, so it can never appear in a diff, a drift report, or a deploy.
    """
    for phase, t in (("import", imported), ("harden", hardened)):
        service = next(r for r in t.to_json()["Resources"].values() if r["Type"] == "AWS::ECS::Service")["Properties"]
        assert service["DeploymentConfiguration"]["MinimumHealthyPercent"] == 100, f"{phase} phase renders a value that is not the live 100"
    # And with the ECS half of harden held back — the step 9a template, the one
    # that updates the service for its tag while hardenEcs is false.
    held = _core("harden", hardenEcs="false", drVaultArn="arn:aws:backup:ap-southeast-1:123456789012:backup-vault:reep-vault-dr")
    service = next(r for r in held.to_json()["Resources"].values() if r["Type"] == "AWS::ECS::Service")["Properties"]
    assert service["DeploymentConfiguration"]["MinimumHealthyPercent"] == 100, "step 9a would send 50 to the live service mid-conversion"


def test_one_retention_number_everywhere(hardened: Template) -> None:
    """RDS automated backups, the daily rule, the DR copy and the vault lock
    all read backupRetentionDays. They were 14 and 35."""
    t = hardened.to_json()["Resources"]
    db = next(r for r in t.values() if r["Type"] == "AWS::RDS::DBInstance")["Properties"]
    plan = next(r for r in t.values() if r["Type"] == "AWS::Backup::BackupPlan")["Properties"]["BackupPlan"]
    vault = next(r for r in t.values() if r["Type"] == "AWS::Backup::BackupVault")["Properties"]
    rule = plan["BackupPlanRule"][0]
    n = db["BackupRetentionPeriod"]
    assert rule["Lifecycle"]["DeleteAfterDays"] == n
    assert rule["CopyActions"][0]["Lifecycle"]["DeleteAfterDays"] == n
    assert vault["LockConfiguration"]["MinRetentionDays"] == n
    assert n >= 35


def test_the_vault_is_locked_in_governance_mode_by_default(hardened: Template) -> None:
    vault = next(r for r in hardened.to_json()["Resources"].values() if r["Type"] == "AWS::Backup::BackupVault")["Properties"]
    assert "MinRetentionDays" in vault["LockConfiguration"]
    assert "ChangeableForDays" not in vault["LockConfiguration"], "compliance mode is irreversible and must be opt-in"


def test_recovery_points_are_copied_to_the_dr_region(hardened: Template) -> None:
    hardened.has_resource_properties(
        "AWS::Backup::BackupPlan",
        {"BackupPlan": Match.object_like({"BackupPlanRule": Match.array_with([Match.object_like({"CopyActions": Match.array_with([Match.object_like({"DestinationBackupVaultArn": Match.string_like_regexp("ap-southeast-1")})])})])})},
    )


def test_a_weekly_restore_test_exists_for_the_database(hardened: Template) -> None:
    hardened.resource_count_is("AWS::Backup::RestoreTestingPlan", 1)
    hardened.has_resource_properties("AWS::Backup::RestoreTestingSelection", {"ProtectedResourceType": "RDS"})
    hardened.has_resource_properties("AWS::CloudWatch::Alarm", {"AlarmName": "reep-backup-job-failed"})


#: How far a backup job must stay from an RDS window. RDS rejects a snapshot
#: taken "inside or too close to" the maintenance window without saying how
#: close is too close, so an hour is the margin we can defend.
BACKUP_WINDOW_CLEARANCE_MINUTES = 60


def _minutes_past_midnight(hhmm: str) -> int:
    hour, minute = hhmm.split(":")
    return int(hour) * 60 + int(minute)


def _window_bounds(window: str) -> tuple[int, int]:
    """`sun:21:30-sun:22:30` or `20:30-21:30` -> (start, end) in minutes UTC."""
    start, end = window.split("-")
    # The maintenance window carries a weekday prefix; the backup window does not.
    strip_day = lambda part: part.split(":", 1)[1] if part.count(":") == 2 else part  # noqa: E731
    return _minutes_past_midnight(strip_day(start)), _minutes_past_midnight(strip_day(end))


def test_backup_schedule_clears_the_rds_windows(hardened: Template) -> None:
    """The AWS Backup rule must not fire inside — or within an hour of — either
    RDS window.

    It fired at 21:30 UTC, which is the exact minute `PreferredMaintenanceWindow`
    opens on a Sunday, and RDS refused the snapshot: "could not start because it
    is either inside or too close to the weekly maintenance window". So every
    Sunday's DATABASE backup failed while the EFS half of the same plan kept
    succeeding — the vault looked healthy, and the newest RDS recovery point
    quietly went stale. Nothing reported it, because the alarm that would
    (`reep-backup-job-failed`) ships in this same harden phase, which had never
    been deployed. Found against the live account on 2026-09-07, where the
    2026-09-06 job was FAILED and the newest RDS point was two days old.

    This asserts the relationship, not the literal time, because moving either
    window is a legitimate fix and pinning one string would only pin the bug.
    """
    plan = next(iter(hardened.find_resources("AWS::Backup::BackupPlan").values()))
    rules = plan["Properties"]["BackupPlan"]["BackupPlanRule"]
    assert rules, "the harden phase must define at least one backup rule"

    db = next(iter(hardened.find_resources("AWS::RDS::DBInstance").values()))["Properties"]
    windows = {
        "maintenance": _window_bounds(db["PreferredMaintenanceWindow"]),
        "automated backup": _window_bounds(db["PreferredBackupWindow"]),
    }

    for rule in rules:
        # cron(minute hour day-of-month month day-of-week year)
        fields = re.fullmatch(r"cron\((\d{1,2}) (\d{1,2}) .*\)", rule["ScheduleExpression"])
        assert fields, f"unparseable schedule expression {rule['ScheduleExpression']!r}"
        fires_at = int(fields.group(2)) * 60 + int(fields.group(1))
        for name, (start, end) in windows.items():
            too_close = start - BACKUP_WINDOW_CLEARANCE_MINUTES <= fires_at <= end + BACKUP_WINDOW_CLEARANCE_MINUTES
            assert not too_close, (
                f"backup rule {rule['RuleName']!r} fires at "
                f"{fires_at // 60:02d}:{fires_at % 60:02d} UTC, inside or within "
                f"{BACKUP_WINDOW_CLEARANCE_MINUTES} min of the RDS {name} window "
                f"{start // 60:02d}:{start % 60:02d}-{end // 60:02d}:{end % 60:02d} — "
                "every job that lands there fails, and it fails silently"
            )


def test_multi_az_defaults_on_in_harden_and_can_be_opted_out(hardened: Template) -> None:
    hardened.has_resource_properties("AWS::RDS::DBInstance", {"MultiAZ": True})
    opted_out = _core("harden", dbMultiAz="false")
    opted_out.has_resource_properties("AWS::RDS::DBInstance", {"MultiAZ": False})


def test_task_role_may_send_mail_only_for_the_verified_identity(hardened: Template) -> None:
    hardened.has_resource_properties(
        "AWS::IAM::Role",
        {
            "RoleName": "reep-api-task",
            "Policies": Match.array_with(
                [
                    Match.object_like(
                        {
                            "PolicyName": "send-mail",
                            "PolicyDocument": Match.object_like(
                                {
                                    "Statement": Match.array_with(
                                        [
                                            Match.object_like(
                                                {
                                                    "Action": ["ses:SendEmail", "ses:SendRawEmail"],
                                                    "Resource": "arn:aws:ses:ap-south-1:123456789012:identity/bgscet.ac.in",
                                                    "Condition": {"StringEquals": {"ses:FromAddress": "reep@bgscet.ac.in"}},
                                                }
                                            )
                                        ]
                                    )
                                }
                            ),
                        }
                    )
                ]
            ),
        },
    )
    hardened.has_resource_properties(
        "AWS::ECS::TaskDefinition",
        {"ContainerDefinitions": Match.array_with([Match.object_like({"Environment": Match.array_with([{"Name": "SES_FROM_ADDRESS", "Value": "reep@bgscet.ac.in"}])})])},
    )


def test_secrets_are_referenced_never_written(imported: Template, hardened: Template) -> None:
    for t in (imported, hardened):
        types = {r["Type"] for r in t.to_json()["Resources"].values()}
        assert "AWS::SecretsManager::Secret" not in types
        assert "AWS::SecretsManager::SecretTargetAttachment" not in types
    hardened.has_resource_properties(
        "AWS::ECS::TaskDefinition",
        {"ContainerDefinitions": Match.array_with([Match.object_like({"Secrets": Match.array_with([Match.object_like({"Name": "DATABASE_URL", "ValueFrom": Match.string_like_regexp(":DATABASE_URL::$")})])})])},
    )


def _container_secret_names(template: Template) -> set[str]:
    names: set[str] = set()
    for resource in template.to_json()["Resources"].values():
        if resource["Type"] != "AWS::ECS::TaskDefinition":
            continue
        for container in resource["Properties"].get("ContainerDefinitions", []):
            names.update(s["Name"] for s in container.get("Secrets", []))
    return names


def test_the_jobs_dsn_secret_is_opt_in_and_off_by_default(imported: Template, hardened: Template) -> None:
    """An ECS task that references a secret KEY the JSON does not hold fails to
    START — every task on that definition, the api included — so the
    reep-scheduled-jobs DSN (read by app/retention_job.py as SENTRY_JOBS_DSN)
    must not be referenced until an operator has added the key to the
    reep/external secret. Off by default in BOTH phases, so the import mirror
    stays byte-identical; on only through the `sentryJobsDsn` context flag."""
    assert "SENTRY_DSN" in _container_secret_names(hardened)
    for template in (imported, hardened):
        assert "SENTRY_JOBS_DSN" not in _container_secret_names(template)
    opted = _core(
        "harden",
        sentryJobsDsn="true",
        wafWebAclArn="arn:aws:wafv2:us-east-1:123456789012:global/webacl/reep-edge/abc",
        drVaultArn="arn:aws:backup:ap-southeast-1:123456789012:backup-vault:reep-vault-dr",
        sesIdentityDomain="bgscet.ac.in",
        sesFromAddress="reep@bgscet.ac.in",
        alertEmail="ops@bgscet.ac.in",
    )
    assert "SENTRY_JOBS_DSN" in _container_secret_names(opted)
    opted.has_resource_properties(
        "AWS::ECS::TaskDefinition",
        {"ContainerDefinitions": Match.array_with([Match.object_like({"Secrets": Match.array_with([Match.object_like({"Name": "SENTRY_JOBS_DSN", "ValueFrom": Match.string_like_regexp(":SENTRY_JOBS_DSN::$")})])})])},
    )


def test_invalid_phase_is_refused() -> None:
    with pytest.raises(ValueError):
        _core("production")


# ------------------------------------------------------ companion stacks --


def test_edge_waf_has_the_three_terraform_rules() -> None:
    app = cdk.App()
    t = Template.from_stack(EdgeWafStack(app, "test-edge", env=cdk.Environment(account="123456789012", region="us-east-1")))
    t.has_resource_properties("AWS::WAFv2::WebACL", {"Name": "reep-edge", "Scope": "CLOUDFRONT"})
    rules = next(r for r in t.to_json()["Resources"].values() if r["Type"] == "AWS::WAFv2::WebACL")["Properties"]["Rules"]
    assert [r["Name"] for r in rules] == ["aws-common", "aws-bad-inputs", "rate-limit"]
    assert rules[2]["Statement"]["RateBasedStatement"]["Limit"] == 2000
    # Priorities are what WAF evaluates by; the live ACL lists them in a
    # different array order and that is not a difference.
    assert sorted((r["Priority"], r["Name"]) for r in rules) == [(1, "aws-common"), (2, "aws-bad-inputs"), (3, "rate-limit")]


def test_no_stack_level_tags_in_any_phase() -> None:
    """INCIDENT (2026-09-07): the step-3 rehearsal import failed with

        As part of the import operation, you cannot modify or add [RoleArn, Tags]

    `Tags.of(stack).add(...)` tags the Stack itself, and CDK passes a tagged
    stack's tags to CreateChangeSet as STACK tags, which CloudFormation refuses
    on an import change set. Nothing offline could have caught it: the template
    is identical either way — the difference is in the manifest, and so in the
    API call. The core import would have failed the same way on all 65
    resources.

    Tags are applied to the stack's CHILDREN now. This asserts the stack itself
    carries none, in every phase and for every stack the cutover imports, while
    the resources still carry theirs.
    """
    for label, stack_factory in (
        ("core/import", lambda app: CoreStack(app, "c", project="reep", env=cdk.Environment(account="123456789012", region="ap-south-1"))),
        ("edge/import", lambda app: EdgeWafStack(app, "e", project="reep", env=cdk.Environment(account="123456789012", region="us-east-1"))),
    ):
        app = cdk.App(context={**CDK_JSON_CONTEXT, "phase": "import"})
        stack = stack_factory(app)
        assert not stack.tags.render_tags(), f"{label}: the STACK is tagged, which CloudFormation refuses on an import change set"
        rendered = Template.from_stack(stack).to_json()["Resources"]
        tagged = [r for r in rendered.values() if r.get("Properties", {}).get("Tags")]
        assert tagged, f"{label}: no resource carries tags — the aspect stopped reaching the children"


def test_the_edge_waf_is_adopted_with_terraforms_tag() -> None:
    """INCIDENT (2026-09-07, the pre-import review): the core stack keeps
    ManagedBy=terraform in the import phase so nothing shows MODIFIED for a
    label. The edge stack was the one place that rule was not applied — it
    tagged the ACL `cdk` unconditionally, which would have put a property
    difference into step 3's diff. Step 3 is the REHEARSAL: its entire value is
    that it comes back showing only CDKMetadata and the output, so an operator
    who sees anything else knows the mirror is wrong."""
    for phase, expected in (("import", "terraform"), ("harden", "cdk")):
        app = cdk.App(context={"phase": phase})
        t = Template.from_stack(EdgeWafStack(app, "test-edge", env=cdk.Environment(account="123456789012", region="us-east-1")))
        acl = next(r for r in t.to_json()["Resources"].values() if r["Type"] == "AWS::WAFv2::WebACL")
        tags = {tag["Key"]: tag["Value"] for tag in acl["Properties"]["Tags"]}
        assert tags["ManagedBy"] == expected, f"{phase} phase tags the adopted ACL {tags['ManagedBy']!r}"
        assert acl.get("DeletionPolicy") == "Retain"


def test_dr_vault_is_locked_with_the_same_minimum() -> None:
    app = cdk.App()
    t = Template.from_stack(DrVaultStack(app, "test-dr", min_retention_days=35, env=cdk.Environment(account="123456789012", region="ap-southeast-1")))
    t.has_resource_properties("AWS::Backup::BackupVault", {"BackupVaultName": "reep-vault-dr", "LockConfiguration": {"MinRetentionDays": 35}})


def test_nothing_in_the_stack_deletes_on_removal(imported: Template, hardened: Template) -> None:
    """`cdk import` requires Retain on every adopted resource, and after the
    cutover a rename or a stray `cdk destroy` must forget student data, never
    delete it. The database is Snapshot; everything else is Retain."""
    for t in (imported, hardened):
        for lid, res in t.to_json()["Resources"].items():
            policy = res.get("DeletionPolicy")
            assert policy in ("Retain", "Snapshot", "RetainExceptOnCreate"), f"{lid} ({res['Type']}) would be deleted: {policy!r}"


# --------------------------------------------- the council's blockers --


def test_import_phase_carries_the_live_database_values_not_the_harden_targets(imported: Template) -> None:
    """cdk.json sets dbMultiAz=true and backupRetentionDays=35 — the HARDEN
    targets. The import mirror must ignore them: import does not compare
    properties, so a mirror saying Multi-AZ against a single-AZ instance
    imports fine and then harden, carrying the same value, sends no change.
    Multi-AZ would silently never happen."""
    imported.has_resource_properties("AWS::RDS::DBInstance", {"MultiAZ": False, "BackupRetentionPeriod": 14, "AllocatedStorage": "20"})
    live = _core("import", liveDbMultiAz="true", liveBackupRetentionDays=7, liveAllocatedStorage=45)
    live.has_resource_properties("AWS::RDS::DBInstance", {"MultiAZ": True, "BackupRetentionPeriod": 7, "AllocatedStorage": "45"})


def test_import_phase_has_no_resource_that_exists_nowhere(imported: Template) -> None:
    """The L2s used to add three: a 0.0.0.0/0:80 ingress on the ALB group
    (bypassing the WAF), a duplicate :3300 ingress, and an IAM::Policy on the
    execution role. None is in Terraform or in the account; one is a hole."""
    types = [r["Type"] for r in imported.to_json()["Resources"].values()]
    assert "AWS::EC2::SecurityGroupIngress" not in types
    assert "AWS::IAM::Policy" not in types


def test_every_import_phase_type_has_a_registry_identifier(imported: Template) -> None:
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
    from import_map import IDENTIFIERS  # noqa: E402

    types = {r["Type"] for r in imported.to_json()["Resources"].values()}
    unknown = sorted(types - set(IDENTIFIERS))
    assert not unknown, f"types the import tool cannot identify: {unknown}"


def test_the_service_does_not_pin_desired_count(imported: Template, hardened: Template) -> None:
    for t in (imported, hardened):
        svc = next(r for r in t.to_json()["Resources"].values() if r["Type"] == "AWS::ECS::Service")["Properties"]
        assert "DesiredCount" not in svc, "autoscaling owns DesiredCount; sending it scales a busy day back down"


def test_the_ecs_half_of_harden_can_be_held_back(hardened: Template) -> None:
    """hardenEcs=false: RDS/backup/vault/alarms without the task-definition,
    target-group and service changes, so a circuit-breaker rollback cannot
    also undo a Multi-AZ conversion in the same stack update."""
    t = _core("harden", hardenEcs="false", drVaultArn="arn:aws:backup:ap-southeast-1:123456789012:backup-vault:reep-vault-dr")
    t.has_resource_properties("AWS::RDS::DBInstance", {"MultiAZ": True, "BackupRetentionPeriod": 35})
    t.has_resource_properties(
        "AWS::ElasticLoadBalancingV2::TargetGroup",
        {"TargetGroupAttributes": Match.array_with([{"Key": "deregistration_delay.timeout_seconds", "Value": "30"}])},
    )
    task = next(r for r in t.to_json()["Resources"].values() if r["Type"] == "AWS::ECS::TaskDefinition")["Properties"]
    assert "StopTimeout" not in task["ContainerDefinitions"][0]


def test_the_database_half_does_not_touch_the_ecs_trio(imported: Template) -> None:
    """INCIDENT (2026-09-07, the pre-import review): step 9a exists so that an
    ECS circuit-breaker rollback cannot undo a Multi-AZ conversion in the same
    stack update. It did not do that. The harden phase flips every resource's
    ManagedBy tag, and **a task definition is immutable** — changing its tags
    registers a NEW REVISION, which the service then rolls onto. So 9a
    modified 46 resources, the task definition, service and target group
    among them, and would have rolled the API in the same update as the
    database conversion. The split was a comment, not a property.

    Now it is a property: at `hardenEcs=false` those three resources are
    byte-identical to the import mirror, so CloudFormation has nothing to send
    for them.
    """
    trio = ("AWS::ECS::TaskDefinition", "AWS::ECS::Service", "AWS::ElasticLoadBalancingV2::TargetGroup")
    step_9a = _core("harden", hardenEcs="false", drVaultArn="arn:aws:backup:ap-southeast-1:123456789012:backup-vault:reep-vault-dr")
    before, after = imported.to_json()["Resources"], step_9a.to_json()["Resources"]

    for cfn_type in trio:
        lid = next(l for l, r in before.items() if r["Type"] == cfn_type)
        assert before[lid] == after[lid], f"step 9a would update {cfn_type} ({lid}) — that is an API roll during the Multi-AZ conversion"

    # And 9b must still make the changes it is supposed to: the tag flip and
    # the deregistration delay. A split that never converges is not a split.
    step_9b = _core("harden", drVaultArn="arn:aws:backup:ap-southeast-1:123456789012:backup-vault:reep-vault-dr")
    final = step_9b.to_json()["Resources"]
    for cfn_type in trio:
        lid = next(l for l, r in before.items() if r["Type"] == cfn_type)
        assert final[lid] != after[lid], f"9b never hardens {cfn_type} — the ECS half would be held back forever"
        tags = {t["Key"]: t["Value"] for t in final[lid]["Properties"].get("Tags", [])}
        assert tags.get("ManagedBy") == "cdk", f"{cfn_type} never reaches ManagedBy=cdk"


def test_retention_above_the_rds_maximum_is_refused() -> None:
    with pytest.raises(ValueError):
        _core("harden", backupRetentionDays=36)


def test_security_groups_and_subnet_group_carry_terraforms_descriptions(imported: Template) -> None:
    """GroupDescription is create-only. Terraform never set one, so the live
    value is its default; anything else is a permanent MODIFIED and a
    replacement attempt the day someone tries to fix it."""
    for res in imported.to_json()["Resources"].values():
        if res["Type"] == "AWS::EC2::SecurityGroup":
            assert res["Properties"]["GroupDescription"] == "Managed by Terraform"
    imported.has_resource_properties("AWS::RDS::DBSubnetGroup", {"DBSubnetGroupDescription": "Managed by Terraform"})


def test_the_import_mirror_keeps_terraforms_tag_and_the_eip_keeps_it_forever(imported: Template, hardened: Template) -> None:
    def tag(res: dict, key: str) -> str | None:
        return next((t["Value"] for t in res.get("Properties", {}).get("Tags", []) if t["Key"] == key), None)

    vpc = next(r for r in imported.to_json()["Resources"].values() if r["Type"] == "AWS::EC2::VPC")
    assert tag(vpc, "ManagedBy") == "terraform"
    eip = next(r for r in hardened.to_json()["Resources"].values() if r["Type"] == "AWS::EC2::EIP")
    assert tag(eip, "ManagedBy") == "terraform", "a tag update on an EIP may reassociate the address"
    vpc_h = next(r for r in hardened.to_json()["Resources"].values() if r["Type"] == "AWS::EC2::VPC")
    assert tag(vpc_h, "ManagedBy") == "cdk"


def test_all_three_stacks_retain_everything() -> None:
    app = cdk.App()
    for stack in (
        EdgeWafStack(app, "e", env=cdk.Environment(account="123456789012", region="us-east-1")),
        DrVaultStack(app, "d", min_retention_days=35, env=cdk.Environment(account="123456789012", region="ap-southeast-1")),
    ):
        for lid, res in Template.from_stack(stack).to_json()["Resources"].items():
            assert res.get("DeletionPolicy") == "Retain", f"{stack.stack_name}/{lid}"


def test_three_backup_failure_alarms(hardened: Template) -> None:
    for name in ("reep-backup-job-failed", "reep-backup-copy-failed", "reep-backup-restore-test-failed"):
        hardened.has_resource_properties("AWS::CloudWatch::Alarm", {"AlarmName": name})


@requires_terraform
def test_the_tls_branch_synthesises_with_terraforms_listener_policy() -> None:
    """The TLS branch is the LIVE branch — the ALB has a certificate — and no
    guard had ever synthesised it: the first rehearsal (test_cutover_tools.py)
    found `SslPolicy.TLS13_12`, a member the library does not have, so
    `cdk synth` with the real context crashed before any import could start.
    The policy is a mutable listener property, so a mismatch is a MODIFIED
    drift at step 5 and a changed live policy at step 9; it is read from
    alb.tf rather than typed twice."""
    tf_text = (TF_DIR / "alb.tf").read_text(encoding="utf-8")
    policy = re.search(r'ssl_policy\s*=\s*"([^"]+)"', tf_text).group(1)
    t = _core("import", albAcmCertificateArn="arn:aws:acm:ap-south-1:123456789012:certificate/alb-cert")
    listeners = [r["Properties"] for r in t.to_json()["Resources"].values() if r["Type"] == "AWS::ElasticLoadBalancingV2::Listener"]
    assert sorted(lst["Port"] for lst in listeners) == [80, 443]
    https = next(lst for lst in listeners if lst["Port"] == 443)
    assert https["Protocol"] == "HTTPS"
    assert https["SslPolicy"] == policy, f"alb.tf says {policy!r}; the mirror renders {https.get('SslPolicy')!r}"
    redirect = next(lst for lst in listeners if lst["Port"] == 80)
    assert redirect["DefaultActions"][0]["Type"] == "redirect"


def test_an_existing_oidc_provider_is_referenced_not_redeclared() -> None:
    t = _core("import", githubOidcProviderArn="arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com")
    t.resource_count_is("AWS::IAM::OIDCProvider", 0)
