#!/usr/bin/env python3
"""Build the `cdk import` resource map and the import-time context from the
Terraform state — so every identifier and every mirrored value is READ from
what exists, never typed.

    cd infra/aws  && terraform show -json > ../cdk/tf-state.json
    cd ../cdk     && cdk synth reep-core -c phase=import --quiet
    python tools/import_map.py tf-state.json cdk.out/reep-core.template.json

On success it writes two files next to cdk.json:

    import-map.json      {LogicalId: {IdentifierKey: value, ...}} for
                         `cdk import --resource-mapping import-map.json`
    cdk.context.json     merged: everything the stack must render identically —
                         the random-suffix names, the secret ARNs, the AZs, the
                         prefix list, the WAF ARN, AND the variable-driven values
                         (certificates, domain, cpu/memory, task counts, instance
                         class, the LIVE multi-AZ / retention / storage, the
                         alert address, the container environment)

WHY A TOOL AND NOT A FORM. Two dozen identifiers, several of them random
suffixes Terraform chose. One typo in a security-group name is a group
CloudFormation cannot find; one typo in the database identifier is an import
that adopts NOTHING and a first deploy that tries to create `reep-postgres`
beside the real one. And the *values* matter as much as the ids: a mirror
that says Multi-AZ when the instance is single-AZ imports fine (CloudFormation
does not compare properties on import) and then never converts it, because
the harden template carries the same value and nothing changes.

THE IDENTIFIER KEYS ARE THE REGISTRY'S, NOT A GUESS. Eight of the first
draft's thirty were wrong (composite keys collapsed to one part, a name where
an ARN was required). CloudFormation validates them when the IMPORT change set
is created, so a wrong key fails before anything changes — but a runbook that
fails at step 4 is not a runbook. The authoritative cross-check is

    aws cloudformation get-template-summary \\
        --template-body file://cdk.out/reep-core.template.json \\
        --query ResourceIdentifierSummaries

and docs/cdk-cutover.md runs it beside this tool.

WHAT IT REFUSES. Any template resource with no identifier; any identifier
whose value the state does not hold; any mirrored value it cannot source from
the state. It writes NOTHING until every check passes — a partial map on disk
is how an import adopts half a stack and the next deploy creates the other
half twice.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

#: CloudFormation registry primaryIdentifier per type, as a tuple of keys.
#: A composite identifier needs EVERY part. A type missing here is a type this
#: tool has not been taught; it is reported, not guessed.
IDENTIFIERS: dict[str, tuple[str, ...]] = {
    "AWS::EC2::VPC": ("VpcId",),
    "AWS::EC2::InternetGateway": ("InternetGatewayId",),
    "AWS::EC2::VPCGatewayAttachment": ("AttachmentType", "VpcId"),
    "AWS::EC2::Subnet": ("SubnetId",),
    "AWS::EC2::EIP": ("PublicIp", "AllocationId"),
    "AWS::EC2::NatGateway": ("NatGatewayId",),
    "AWS::EC2::RouteTable": ("RouteTableId",),
    "AWS::EC2::Route": ("RouteTableId", "CidrBlock"),
    "AWS::EC2::SubnetRouteTableAssociation": ("Id",),
    "AWS::EC2::SecurityGroup": ("Id",),
    "AWS::EFS::FileSystem": ("FileSystemId",),
    "AWS::EFS::MountTarget": ("Id",),
    "AWS::EFS::AccessPoint": ("AccessPointId",),
    "AWS::S3::Bucket": ("BucketName",),
    "AWS::S3::BucketPolicy": ("Bucket",),
    "AWS::Logs::LogGroup": ("LogGroupName",),
    "AWS::Logs::MetricFilter": ("LogGroupName", "FilterName"),
    "AWS::SNS::Topic": ("TopicArn",),
    "AWS::ECR::Repository": ("RepositoryName",),
    "AWS::RDS::DBSubnetGroup": ("DBSubnetGroupName",),
    "AWS::RDS::DBInstance": ("DBInstanceIdentifier",),
    "AWS::Backup::BackupVault": ("BackupVaultName",),
    "AWS::Backup::BackupPlan": ("BackupPlanId",),
    "AWS::Backup::BackupSelection": ("Id",),  # composed: <BackupPlanId>_<SelectionId>
    "AWS::IAM::Role": ("RoleName",),
    "AWS::IAM::OIDCProvider": ("Arn",),
    "AWS::ElasticLoadBalancingV2::LoadBalancer": ("LoadBalancerArn",),
    "AWS::ElasticLoadBalancingV2::TargetGroup": ("TargetGroupArn",),
    "AWS::ElasticLoadBalancingV2::Listener": ("ListenerArn",),
    "AWS::ECS::Cluster": ("ClusterName",),
    "AWS::ECS::TaskDefinition": ("TaskDefinitionArn",),
    "AWS::ECS::Service": ("ServiceArn", "Cluster"),
    "AWS::ApplicationAutoScaling::ScalableTarget": ("ResourceId", "ScalableDimension", "ServiceNamespace"),
    "AWS::ApplicationAutoScaling::ScalingPolicy": ("Arn", "ScalableDimension"),
    "AWS::Scheduler::Schedule": ("Name",),
    "AWS::CloudFront::Function": ("FunctionARN",),
    "AWS::CloudFront::OriginAccessControl": ("Id",),
    "AWS::CloudFront::Distribution": ("Id",),
    "AWS::CloudWatch::Alarm": ("AlarmName",),
    "AWS::WAFv2::WebACL": ("Name", "Id", "Scope"),
}

_SCALABLE_DIMENSION = "ecs:service:DesiredCount"

#: Environment variables the stack renders from context; each is read from the
#: live container definition so the mirror carries the running values.
_ENV_TO_CONTEXT = {
    "BEDROCK_MODEL": "bedrockModel",
    "NOVA_SONIC_REGION": "novaSonicRegion",
    "INTERVIEW_ENGINE": "interviewEngine",
    "INTERVIEW_RECORDING_ENABLED": "interviewRecordingEnabled",
    "INTERVIEW_CONSENT_VERSION": "interviewConsentVersion",
    "LLM_ALLOW_REMOTE_STUDENT_DATA": "allowRemoteStudentData",
}


def _tf_resources(state: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten `terraform show -json` into the managed resources."""
    out: list[dict[str, Any]] = []

    def walk(module: dict[str, Any]) -> None:
        for r in module.get("resources", []):
            if r.get("mode") == "managed":
                out.append(r)
        for child in module.get("child_modules", []):
            walk(child)

    walk(state.get("values", {}).get("root_module", {}))
    return out


def _one(resources: list[dict[str, Any]], tf_type: str, name: str, index: int | None = None) -> dict[str, Any] | None:
    for r in resources:
        if r["type"] != tf_type or r["name"] != name:
            continue
        if index is not None and r.get("index") != index:
            continue
        return r["values"]
    return None


def build(state: dict[str, Any], template: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    tf = _tf_resources(state)
    resources: dict[str, Any] = template["Resources"]
    mapping: dict[str, dict[str, str]] = {}
    problems: list[str] = []

    def put(logical: str, **keys: Any) -> None:
        cfn_type = resources[logical]["Type"]
        expected = IDENTIFIERS[cfn_type]
        missing = [k for k in expected if keys.get(k) in (None, "")]
        if missing or set(keys) != set(expected):
            problems.append(f"{logical} ({cfn_type}): identifier needs {expected}, got {sorted(keys)} (empty: {missing})")
            return
        mapping[logical] = {k: str(v) for k, v in keys.items()}

    def only(cfn_type: str) -> str | None:
        hits = [lid for lid, res in resources.items() if res["Type"] == cfn_type]
        if len(hits) == 1:
            return hits[0]
        if hits:
            problems.append(f"{cfn_type}: expected one in the template, found {hits}")
        return None

    def need(tf_type: str, name: str, index: int | None = None) -> dict[str, Any]:
        v = _one(tf, tf_type, name, index)
        if v is None:
            problems.append(f"{tf_type}.{name}{'' if index is None else f'[{index}]'} is not in the state")
            return {}
        return v

    vpc = need("aws_vpc", "main")
    igw = need("aws_internet_gateway", "main")
    eip = need("aws_eip", "nat")
    nat = need("aws_nat_gateway", "main")
    fs = need("aws_efs_file_system", "data")
    ap = need("aws_efs_access_point", "data")
    lg = need("aws_cloudwatch_log_group", "api")
    mf = need("aws_cloudwatch_log_metric_filter", "dropped_turns")
    topic = need("aws_sns_topic", "alerts")
    repo = need("aws_ecr_repository", "api")
    dbsg = need("aws_db_subnet_group", "main")
    db = need("aws_db_instance", "main")
    vault = need("aws_backup_vault", "main")
    plan = need("aws_backup_plan", "daily")
    sel = need("aws_backup_selection", "db_and_efs")
    alb = need("aws_lb", "main")
    tg = need("aws_lb_target_group", "api")
    cluster = need("aws_ecs_cluster", "main")
    taskdef = need("aws_ecs_task_definition", "api")
    service = need("aws_ecs_service", "api")
    target = need("aws_appautoscaling_target", "api")
    schedule = need("aws_scheduler_schedule", "retention")
    cf_fn = need("aws_cloudfront_function", "spa_fallback")
    oac = need("aws_cloudfront_origin_access_control", "web")
    dist = need("aws_cloudfront_distribution", "main")

    # --- one-of-a-kind resources ------------------------------------------
    singles: list[tuple[str, dict[str, Any]]] = [
        ("AWS::EC2::VPC", {"VpcId": vpc.get("id")}),
        ("AWS::EC2::InternetGateway", {"InternetGatewayId": igw.get("id")}),
        ("AWS::EC2::VPCGatewayAttachment", {"AttachmentType": "internet", "VpcId": vpc.get("id")}),
        ("AWS::EC2::EIP", {"PublicIp": eip.get("public_ip"), "AllocationId": eip.get("allocation_id") or eip.get("id")}),
        ("AWS::EC2::NatGateway", {"NatGatewayId": nat.get("id")}),
        ("AWS::EFS::FileSystem", {"FileSystemId": fs.get("id")}),
        ("AWS::EFS::AccessPoint", {"AccessPointId": ap.get("id")}),
        ("AWS::Logs::LogGroup", {"LogGroupName": lg.get("name")}),
        ("AWS::Logs::MetricFilter", {"LogGroupName": mf.get("log_group_name"), "FilterName": mf.get("name")}),
        ("AWS::SNS::Topic", {"TopicArn": topic.get("arn")}),
        ("AWS::ECR::Repository", {"RepositoryName": repo.get("name")}),
        ("AWS::RDS::DBSubnetGroup", {"DBSubnetGroupName": dbsg.get("name")}),
        ("AWS::RDS::DBInstance", {"DBInstanceIdentifier": db.get("identifier")}),
        ("AWS::Backup::BackupVault", {"BackupVaultName": vault.get("name")}),
        ("AWS::Backup::BackupPlan", {"BackupPlanId": plan.get("id")}),
        # The registry composes this one: <BackupPlanId>_<SelectionId>.
        ("AWS::Backup::BackupSelection", {"Id": f"{sel.get('plan_id')}_{sel.get('id')}" if sel else None}),
        ("AWS::ElasticLoadBalancingV2::LoadBalancer", {"LoadBalancerArn": alb.get("arn")}),
        ("AWS::ElasticLoadBalancingV2::TargetGroup", {"TargetGroupArn": tg.get("arn")}),
        ("AWS::ECS::Cluster", {"ClusterName": cluster.get("name")}),
        ("AWS::ECS::TaskDefinition", {"TaskDefinitionArn": taskdef.get("arn")}),
        ("AWS::ECS::Service", {"ServiceArn": service.get("id"), "Cluster": cluster.get("name")}),
        (
            "AWS::ApplicationAutoScaling::ScalableTarget",
            {"ResourceId": target.get("resource_id"), "ScalableDimension": _SCALABLE_DIMENSION, "ServiceNamespace": "ecs"},
        ),
        ("AWS::Scheduler::Schedule", {"Name": schedule.get("name")}),
        ("AWS::CloudFront::Function", {"FunctionARN": cf_fn.get("arn")}),
        ("AWS::CloudFront::OriginAccessControl", {"Id": oac.get("id")}),
        ("AWS::CloudFront::Distribution", {"Id": dist.get("id")}),
    ]
    for cfn_type, keys in singles:
        lid = only(cfn_type)
        if lid:
            put(lid, **keys)
    oidc = _one(tf, "aws_iam_openid_connect_provider", "github", index=0)
    lid = only("AWS::IAM::OIDCProvider")
    if lid:
        if oidc:
            put(lid, Arn=oidc.get("arn"))
        else:
            problems.append(f"{lid}: no aws_iam_openid_connect_provider.github[0] in the state — set -c githubOidcProviderArn and drop the resource")

    # --- indexed / named families -----------------------------------------
    for i in range(2):
        for kind, tf_name in (("Public", "public"), ("Private", "private")):
            sn = need("aws_subnet", tf_name, i)
            if sn:
                put(f"{kind}Subnet{i}", SubnetId=sn.get("id"))
            assoc = need("aws_route_table_association", tf_name, i)
            if assoc:
                put(f"{kind}Rta{i}", Id=assoc.get("id"))
        mt = need("aws_efs_mount_target", "data", i)
        if mt:
            put(f"DataMount{i}", Id=mt.get("id"))
    for kind, tf_name in (("Public", "public"), ("Private", "private")):
        rt = need("aws_route_table", tf_name)
        if rt:
            put(f"{kind}RouteTable", RouteTableId=rt.get("id"))
            put(f"{kind}DefaultRoute", RouteTableId=rt.get("id"), CidrBlock="0.0.0.0/0")
    sg_by_logical = {"AlbSg": "alb", "ApiSg": "api", "DbSg": "db", "EfsSg": "efs"}
    for logical, tf_name in sg_by_logical.items():
        sg = need("aws_security_group", tf_name)
        if sg:
            put(logical, Id=sg.get("id"))
    for logical, tf_name in (
        ("TaskExecutionRole", "task_execution"),
        ("ApiTaskRole", "api_task"),
        ("SchedulerRole", "scheduler"),
        ("BackupRole", "backup"),
        ("ClaudeObserverRole", "claude_observer"),
        ("GithubDeployRole", "github_deploy"),
    ):
        role = need("aws_iam_role", tf_name)
        if role:
            put(logical, RoleName=role.get("name"))
    buckets = {"WebBucket": need("aws_s3_bucket", "web"), "AlbLogsBucket": need("aws_s3_bucket", "alb_logs")}
    for logical, b in buckets.items():
        if b:
            put(logical, BucketName=b.get("bucket"))
    for lid, res in resources.items():
        t = res["Type"]
        p = res.get("Properties", {})
        if t == "AWS::S3::BucketPolicy":
            ref = p["Bucket"].get("Ref") if isinstance(p.get("Bucket"), dict) else None
            if ref in mapping:
                put(lid, Bucket=mapping[ref]["BucketName"])
            else:
                problems.append(f"{lid}: bucket policy for an unmapped bucket ({ref})")
        elif t == "AWS::CloudWatch::Alarm":
            put(lid, AlarmName=p.get("AlarmName"))
        elif t == "AWS::ApplicationAutoScaling::ScalingPolicy":
            tf_name = {"cpu-target": "api_cpu", "memory-target": "api_memory"}.get(p.get("PolicyName"))
            pol = _one(tf, "aws_appautoscaling_policy", tf_name) if tf_name else None
            if pol:
                put(lid, Arn=pol.get("arn"), ScalableDimension=_SCALABLE_DIMENSION)
            else:
                problems.append(f"{lid}: scaling policy {p.get('PolicyName')!r} not in the state")
        elif t == "AWS::ElasticLoadBalancingV2::Listener":
            # Matched on PORT and ACTION, not on a guessed Terraform name: an
            # 80/redirect and an 80/forward are different resources.
            port = p.get("Port")
            action = (p.get("DefaultActions") or [{}])[0].get("Type")
            wanted = "redirect" if action == "redirect" else "forward"
            found = None
            for name in ("http_redirect", "https", "http_origin"):
                lst = _one(tf, "aws_lb_listener", name, index=0)
                if lst and lst.get("port") == port and (lst.get("default_action") or [{}])[0].get("type") == wanted:
                    found = lst
                    break
            if found:
                put(lid, ListenerArn=found.get("arn"))
            else:
                problems.append(f"{lid}: no listener on port {port} with a {wanted} action in the state")

    # --- every import-phase resource must be mapped -------------------------
    for lid, res in resources.items():
        if res["Type"] not in IDENTIFIERS:
            problems.append(f"{lid}: type {res['Type']} is not in IDENTIFIERS — it may not be importable at all")
        elif lid not in mapping:
            problems.append(f"{lid} ({res['Type']}): no mapping rule")

    # --- the values the stack must render identically -----------------------
    context: dict[str, Any] = {}

    def ctx(key: str, value: Any, *, required: bool = True) -> None:
        if value in (None, "", []):
            if required:
                problems.append(f"context {key}: not in the state")
            return
        context[key] = value

    ctx("webBucketName", buckets["WebBucket"].get("bucket") if buckets["WebBucket"] else None)
    ctx("albLogsBucketName", buckets["AlbLogsBucket"].get("bucket") if buckets["AlbLogsBucket"] else None)
    ctx("appSecretArn", need("aws_secretsmanager_secret", "app").get("arn"))
    ctx("externalSecretArn", need("aws_secretsmanager_secret", "external").get("arn"))
    for key, tf_name in (
        ("albSecurityGroupName", "alb"),
        ("apiSecurityGroupName", "api"),
        ("dbSecurityGroupName", "db"),
        ("efsSecurityGroupName", "efs"),
    ):
        sg = _one(tf, "aws_security_group", tf_name) or {}
        ctx(key, sg.get("name"))
        # GroupDescription is create-only. The stack renders Terraform's
        # default; anything else is a permanent drift, so refuse to guess.
        if sg and sg.get("description") != "Managed by Terraform":
            problems.append(f"security group {tf_name}: description is {sg.get('description')!r}, the stack renders 'Managed by Terraform'")
    pub = [_one(tf, "aws_subnet", "public", i) or {} for i in range(2)]
    ctx("availabilityZones", [s.get("availability_zone") for s in pub if s.get("availability_zone")])
    alb_sg = _one(tf, "aws_security_group", "alb") or {}
    prefix = next((r["prefix_list_ids"][0] for r in alb_sg.get("ingress", []) if r.get("prefix_list_ids")), None)
    ctx("cloudfrontPrefixListId", prefix, required=False)
    ctx("restrictAlbToCloudfront", bool(prefix))
    waf = _one(tf, "aws_wafv2_web_acl", "edge") or {}
    ctx("wafWebAclArn", waf.get("arn"))
    # TLS shape: read from the listeners that exist, never from a tfvars file.
    https = _one(tf, "aws_lb_listener", "https", index=0)
    ctx("albAcmCertificateArn", https.get("certificate_arn") if https else "", required=False)
    aliases = dist.get("aliases") or []
    ctx("domainName", aliases[0] if aliases else "", required=False)
    vc = (dist.get("viewer_certificate") or [{}])[0]
    ctx("cloudfrontAcmCertificateArn", vc.get("acm_certificate_arn") or "", required=False)
    api_origin = next((o for o in dist.get("origin", []) if o.get("origin_id") == "api-alb"), {})
    origin_domain = api_origin.get("domain_name", "")
    ctx("albOriginDomain", "" if origin_domain == alb.get("dns_name") else origin_domain, required=False)
    ctx("apiCpu", int(taskdef.get("cpu")) if taskdef.get("cpu") else None)
    ctx("apiMemory", int(taskdef.get("memory")) if taskdef.get("memory") else None)
    ctx("apiMinTasks", target.get("min_capacity"))
    ctx("apiMaxTasks", target.get("max_capacity"))
    ctx("dbInstanceClass", db.get("instance_class"))
    # THE LIVE VALUES the import mirror must carry, as opposed to the harden
    # targets in cdk.json. See M1 in docs/cdk-cutover.md.
    ctx("liveDbMultiAz", bool(db.get("multi_az")))
    ctx("liveBackupRetentionDays", db.get("backup_retention_period"))
    ctx("liveAllocatedStorage", db.get("allocated_storage"))
    sub = _one(tf, "aws_sns_topic_subscription", "email") or {}
    ctx("alertEmail", sub.get("endpoint"), required=False)
    ctx("githubOidcProviderArn", oidc.get("arn") if oidc else "", required=False)
    try:
        cdefs = json.loads(taskdef.get("container_definitions") or "[]")
        env = {e["name"]: e["value"] for e in (cdefs[0].get("environment") or [])}
    except (ValueError, IndexError, KeyError):
        env = {}
        problems.append("container_definitions could not be parsed from the state")
    for env_name, key in _ENV_TO_CONTEXT.items():
        ctx(key, env.get(env_name))
    return mapping, context, problems


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    state = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    template = json.loads(Path(argv[2]).read_text(encoding="utf-8"))
    mapping, context, problems = build(state, template)

    if problems:
        print("REFUSING — nothing written. Fix these first:")
        for p in problems:
            print("  -", p)
        return 1

    here = Path(__file__).resolve().parents[1]
    (here / "import-map.json").write_text(json.dumps(mapping, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    ctx_path = here / "cdk.context.json"
    existing = json.loads(ctx_path.read_text(encoding="utf-8")) if ctx_path.exists() else {}
    existing.update(context)
    ctx_path.write_text(json.dumps(existing, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(f"mapped {len(mapping)} resources -> import-map.json")
    print(f"context ({len(context)} keys) -> cdk.context.json")
    waf = next((r["values"] for r in _tf_resources(state) if r["type"] == "aws_wafv2_web_acl"), None)
    if waf:
        print(f"edge WAF identifier for `cdk import reep-edge-waf` (Name|Id|Scope): Name={waf.get('name')} Id={waf.get('id')} Scope=CLOUDFRONT")
    print("\nNow re-synthesise with this context and cross-check the keys against")
    print("  aws cloudformation get-template-summary --template-body file://cdk.out/reep-core.template.json --query ResourceIdentifierSummaries")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
