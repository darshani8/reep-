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


@pytest.mark.parametrize("pattern, expected", _TF_NAME_PATTERNS, ids=[e for _, e in _TF_NAME_PATTERNS])
def test_physical_names_match_terraform(imported: Template, pattern: str, expected: str) -> None:
    tf_text = "\n".join(p.read_text(encoding="utf-8") for p in TF_DIR.glob("*.tf"))
    assert re.search(pattern, tf_text), f"the Terraform files no longer declare {expected!r}; update both sides deliberately"
    assert expected in json.dumps(imported.to_json()), f"{expected!r} is in Terraform but not in the import-phase template"


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


def test_an_existing_oidc_provider_is_referenced_not_redeclared() -> None:
    t = _core("import", githubOidcProviderArn="arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com")
    t.resource_count_is("AWS::IAM::OIDCProvider", 0)
