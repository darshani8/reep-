"""REEP's core AWS footprint as one CDK stack — the successor to infra/aws/.

WHY THIS FILE IS SHAPED THE WAY IT IS. Every resource here already EXISTS,
created by Terraform and holding real student data. This stack is not a fresh
build; it is a description of what is running, precise enough that
`cdk import` can adopt each resource into CloudFormation without touching it.
That single fact decides three things:

  1. PHYSICAL NAMES ARE THE TERRAFORM NAMES, LITERALLY. `reep-api-task`,
     `/reep/api`, `reep-postgres`, `reep-vault`. An import matches on the
     identifier and then compares properties; a different name is a different
     resource, and for an immutable property (a security group's name, a task
     family) the next deploy would REPLACE it — which for the database is an
     outage and for a security group is every task losing its network. The
     names are asserted against the .tf files by the synth tests.

  2. L1 (`Cfn*`) WHEREVER L2 WOULD INVENT STRUCTURE. `ec2.Vpc` lays out its own
     subnets and route tables; `iam.OpenIdConnectProvider` is a Lambda-backed
     custom resource; `rds.DatabaseInstance` mints a new master password.
     None of those can be imported over what exists. L2 is used only where it
     maps 1:1 onto one CloudFormation resource with the properties we need.

  3. TWO PHASES, ONE CONTEXT KEY. `-c phase=import` renders the mirror of what
     exists and NOTHING else — `cdk import` refuses a template that also adds
     resources it cannot import. `-c phase=harden` (the default) is the same
     stack plus every fix this migration exists to make. The synth tests pin
     that the import phase is a strict subset.

WHAT `harden` ADDS, and why each is here rather than in Terraform:

  * The container's `stopTimeout` is 120 s — FARGATE'S HARD MAXIMUM, not the
    500 s the first plan assumed. A 480 s interview is therefore protected by
    the target group's DEREGISTRATION DELAY (600 s): the ALB stops routing
    new connections to a draining task but keeps its open WebSockets until
    they close, and ECS waits for draining before it sends SIGTERM. Then
    uvicorn's `--timeout-graceful-shutdown 110` (Dockerfile) fits inside the
    120. The api's own number is pinned against this file by
    tests/test_codebase_guards.py, so the two cannot drift apart silently.
  * The backup vault is LOCKED (governance mode: a minimum retention nobody
    can shorten by accident), every recovery point is COPIED to a vault in
    ap-southeast-1, and a weekly RESTORE TEST proves the copies are usable —
    a backup that has never been restored is a hope, not a backup.
  * RDS automated retention and the AWS Backup rule read ONE number
    (`backupRetentionDays`). They were 14 and 35 — two answers to "how far
    back can we go", and the honest one was the shorter.
  * Multi-AZ on by default (`-c dbMultiAz=false` to opt out — it doubles the
    instance cost, and that is a decision, so it is written down here).
  * The task role may send mail through SES for the college's verified
    identity (activation and reset links, app/mail_transport.py).
  * A `MasterUserPassword` NEVER appears in this template. The instance keeps
    the password Terraform generated, held inside the app secret's
    DATABASE_URL. Writing one here would rotate it under the running api. A
    synth test refuses the template if the property ever shows up.

Two Terraform resources have no counterpart and are dropped on purpose:
`random_password.db` and `random_password.auth_secret` — their VALUES live in
the secrets already; the generators are not infrastructure. The two
`aws_secretsmanager_secret_version`s are likewise not modelled: this stack
imports the secrets by ARN and never writes a version. Secret values are the
operator's, and a CloudFormation deploy must not be able to overwrite them.
"""

from __future__ import annotations

import json
from typing import Any

from aws_cdk import (
    Aspects,
    CfnOutput,
    CfnResource,
    Duration,
    IAspect,
    RemovalPolicy,
    Stack,
    Tags,
    aws_applicationautoscaling as appscaling,
    aws_backup as backup,
    aws_cloudfront as cloudfront,
    aws_cloudfront_origins as origins,
    aws_cloudwatch as cw,
    aws_cloudwatch_actions as cw_actions,
    aws_ec2 as ec2,
    aws_ecr as ecr,
    aws_ecs as ecs,
    aws_efs as efs,
    aws_elasticloadbalancingv2 as elbv2,
    aws_iam as iam,
    aws_logs as logs,
    aws_rds as rds,
    aws_s3 as s3,
    aws_scheduler as scheduler,
    aws_secretsmanager as sm,
    aws_sns as sns,
    aws_sns_subscriptions as subs,
)
from constructs import Construct, IConstruct
import jsii


@jsii.implements(IAspect)
class RetainEverything:
    """`DeletionPolicy: Retain` on every resource that has not chosen one.

    Two reasons, one for each phase. `cdk import` REQUIRES Retain on every
    resource it adopts (the CLI adds it where missing; setting it here keeps
    it in the harden template too). And after
    the cutover this stack owns the database, the file system, the buckets and
    the log group — a construct-id rename, a refactor that moves a resource,
    or a `cdk destroy` typed into the wrong terminal must forget them, never
    delete them. Explicit policies (the database's Snapshot) are left alone.
    """

    def visit(self, node: IConstruct) -> None:
        if isinstance(node, CfnResource) and node.cfn_options.deletion_policy is None:
            node.apply_removal_policy(RemovalPolicy.RETAIN)


#: Fargate's hard ceiling for a container's stopTimeout. Not a choice: the
#: service refuses a task definition above it. See the module docstring for
#: what actually protects a live interview.
STOP_TIMEOUT_SECONDS = 120

#: How long the ALB keeps a draining target's open connections. Must exceed the
#: longest interview the api will hold on one socket (config.py's
#: nova_sonic_connection_seconds, 480) plus the scorecard tail. Pinned against
#: the api's number by tests/test_codebase_guards.py.
DEREGISTRATION_DELAY_SECONDS = 600

#: The one retention number. RDS automated backups and the AWS Backup rule both
#: read it, and the vault lock's minimum is derived from it.
DEFAULT_BACKUP_RETENTION_DAYS = 35

#: CloudFront's managed policy ids, the same three cdn.tf hardcodes.
_CACHE_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6"
_CACHE_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
_ORIGIN_ALL_VIEWER = "216adef6-5c7f-47e4-b989-5492eafa07d3"

_SPA_FALLBACK_JS = """\
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  // Belt and braces: this function is not attached to the /api/* behavior,
  // but if it is ever attached more widely by mistake, the API must still
  // keep its own status codes.
  if (uri.startsWith('/api/')) {
    return request;
  }
  var last = uri.substring(uri.lastIndexOf('/') + 1);
  if (last.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
"""


class CoreStack(Stack):
    """See the module docstring. Every knob is a CDK context value so the
    import-map tool (tools/import_map.py) can fill the ones that only the live
    account knows — bucket suffixes, security-group names, secret ARNs."""

    def __init__(self, scope: Construct, construct_id: str, *, project: str = "reep", **kwargs: Any) -> None:
        super().__init__(scope, construct_id, **kwargs)
        self.project = project
        ctx = self.node.try_get_context
        self.phase = (ctx("phase") or "harden").strip().lower()
        if self.phase not in ("import", "harden"):
            raise ValueError(f"phase must be 'import' or 'harden', not {self.phase!r}")
        harden = self.phase == "harden"
        self.harden = harden

        # ------------------------------------------------------------ knobs --
        def opt(key: str, default: Any = None) -> Any:
            v = ctx(key)
            return default if v is None or v == "" else v

        def flag(key: str, default: bool) -> bool:
            v = ctx(key)
            if v is None or v == "":
                return default
            return str(v).strip().lower() in ("1", "true", "yes", "on")

        domain_name: str = opt("domainName", "")
        cf_cert_arn: str = opt("cloudfrontAcmCertificateArn", "")
        alb_cert_arn: str = opt("albAcmCertificateArn", "")
        alb_origin_domain: str = opt("albOriginDomain", "")
        restrict_to_cloudfront = flag("restrictAlbToCloudfront", True)
        cloudfront_prefix_list = opt("cloudfrontPrefixListId", "")
        azs: list[str] = list(opt("availabilityZones", ["ap-south-1a", "ap-south-1b"]))
        api_cpu = int(opt("apiCpu", 512))
        api_memory = int(opt("apiMemory", 1024))
        api_min = int(opt("apiMinTasks", 2))
        api_max = int(opt("apiMaxTasks", 10))
        db_class: str = opt("dbInstanceClass", "db.t4g.small")
        # THE IMPORT MIRROR CARRIES THE LIVE VALUES, the harden template the
        # targets — and they must come from DIFFERENT context keys. cdk.json
        # sets the harden targets (dbMultiAz, backupRetentionDays) and the CLI
        # always loads cdk.json, so an import phase that read the same keys
        # would render Multi-AZ against a single-AZ instance. Import does not
        # compare properties, so it would succeed — and then harden, carrying
        # the same value, would send no ModifyDBInstance, and Multi-AZ would
        # silently never happen. tools/import_map.py writes the live* keys
        # from the state.
        if harden:
            db_multi_az = flag("dbMultiAz", True)
            retention_days = int(opt("backupRetentionDays", DEFAULT_BACKUP_RETENTION_DAYS))
        else:
            db_multi_az = flag("liveDbMultiAz", False)
            retention_days = int(opt("liveBackupRetentionDays", 14))
        if not 1 <= retention_days <= 35:
            raise ValueError(f"backupRetentionDays must be 1..35 (RDS refuses more), not {retention_days}")
        allocated_storage = str(opt("liveAllocatedStorage", 20))
        # hardenEcs=false: the database/backup half of harden without the ECS
        # half, so an ECS circuit-breaker rollback cannot also undo a Multi-AZ
        # conversion in the same stack update. Step 9 runs them separately.
        harden_ecs = harden and flag("hardenEcs", True)
        github_oidc_arn: str = opt("githubOidcProviderArn", "")
        alert_email: str = opt("alertEmail", "")
        observer_principal: str = opt("observerPrincipalArn", "")
        gh_repo: str = opt("githubRepository", "darshani8/reep-")
        gh_repo_ids: str = opt("githubRepositoryIds", "darshani8@285224354/reep-@1339637272")
        gh_ref: str = opt("githubDeployRef", "refs/heads/main")
        waf_acl_arn: str = opt("wafWebAclArn", "")
        dr_vault_arn: str = opt("drVaultArn", "")
        ses_identity_domain: str = opt("sesIdentityDomain", "")
        ses_from_address: str = opt("sesFromAddress", "")
        vault_lock_compliance = flag("vaultLockCompliance", False)
        # Identifiers only the live account knows (name_prefix / bucket_prefix
        # gave them random suffixes). tools/import_map.py fills these from the
        # Terraform state; the defaults are shaped so a synth without them still
        # produces a checkable template.
        web_bucket_name: str = opt("webBucketName", f"{project}-web-00000000000000000000")
        alb_logs_bucket_name: str = opt("albLogsBucketName", f"{project}-alb-logs-00000000000000000000")
        app_secret_arn: str = opt(
            "appSecretArn",
            f"arn:aws:secretsmanager:{self.region}:{self.account}:secret:{project}/app-00000000000000000000-AbCdEf",
        )
        external_secret_arn: str = opt(
            "externalSecretArn",
            f"arn:aws:secretsmanager:{self.region}:{self.account}:secret:{project}/external-00000000000000000000-AbCdEf",
        )
        sg_names = {
            "alb": opt("albSecurityGroupName", f"{project}-alb-00000000000000000000"),
            "api": opt("apiSecurityGroupName", f"{project}-api-00000000000000000000"),
            "db": opt("dbSecurityGroupName", f"{project}-db-00000000000000000000"),
            "efs": opt("efsSecurityGroupName", f"{project}-efs-00000000000000000000"),
        }
        api_environment = {
            "ENV": "prod",
            "UPLOAD_DIR": "/data/uploads",
            "INTERVIEW_RECORDING_ENABLED": str(opt("interviewRecordingEnabled", "true")),
            "BEDROCK_MODEL": str(opt("bedrockModel", "apac.amazon.nova-pro-v1:0")),
            "BEDROCK_REGION": self.region,
            "INTERVIEW_CONSENT_VERSION": str(opt("interviewConsentVersion", "2026-09")),
            "INTERVIEW_ENGINE": str(opt("interviewEngine", "nova")),
            "NOVA_SONIC_REGION": str(opt("novaSonicRegion", "ap-northeast-1")),
            "LLM_ALLOW_REMOTE_STUDENT_DATA": str(opt("allowRemoteStudentData", "true")),
        }
        alb_tls = bool(alb_cert_arn.strip())

        # The CloudFront function carries NO tags live — the aws provider has no
        # tags argument for it, so there was never anything to record. Tagging
        # it in the mirror is a drift row at step 5 and a TagResource write at
        # step 9 for a label nobody reads, so it is excluded from both tags in
        # both phases and stays as it is.
        untagged = ["AWS::CloudFront::Function"]
        Tags.of(self).add("Project", project, exclude_resource_types=untagged)
        # The import mirror keeps Terraform's tag so nothing shows MODIFIED for
        # a label. Harden flips it — with two exceptions, both load-bearing.
        #
        # 1. The EIP, whose tag update the EC2 docs warn may reassociate the
        #    address. It keeps ManagedBy=terraform forever.
        # 2. THE ECS TRIO, while the ECS half is held back. A task definition is
        #    IMMUTABLE: changing its tags registers a NEW REVISION, and the
        #    service then rolls onto it. So flipping this tag at step 9a — the
        #    deploy whose entire purpose is to convert the database to Multi-AZ
        #    *without* touching the API — would have rolled the service in the
        #    same CloudFormation update as the conversion, which is the failure
        #    the two-deploy split exists to prevent. Found by the pre-import
        #    review, 2026-09-07: 9a modified 46 resources including the task
        #    definition, the service and the target group. It now modifies
        #    those three at 9b only, alongside the deregistration-delay change
        #    and the new revision that step already expects.
        #    `test_the_database_half_does_not_touch_the_ecs_trio` pins it.
        ecs_roll_types = ["AWS::ECS::TaskDefinition", "AWS::ECS::Service", "AWS::ElasticLoadBalancingV2::TargetGroup"]
        if harden:
            keep_terraform = ["AWS::EC2::EIP"] + ([] if harden_ecs else ecs_roll_types)
            Tags.of(self).add("ManagedBy", "cdk", exclude_resource_types=keep_terraform + untagged)
            Tags.of(self).add("ManagedBy", "terraform", include_resource_types=keep_terraform)
        else:
            Tags.of(self).add("ManagedBy", "terraform", exclude_resource_types=untagged)
        Aspects.of(self).add(RetainEverything())

        # ---------------------------------------------------------- network --
        # network.tf, resource for resource. /16 carved as cidrsubnet(…, 4, i):
        # public 0/1 are the first two /20s, private 0/1 are the ninth and tenth.
        vpc = ec2.CfnVPC(
            self,
            "Vpc",
            cidr_block="10.42.0.0/16",
            enable_dns_support=True,
            enable_dns_hostnames=True,
            tags=[{"key": "Name", "value": f"{project}-vpc"}],
        )
        igw = ec2.CfnInternetGateway(self, "Igw")
        igw_attach = ec2.CfnVPCGatewayAttachment(self, "IgwAttach", vpc_id=vpc.ref, internet_gateway_id=igw.ref)
        public_subnets = [
            ec2.CfnSubnet(
                self,
                f"PublicSubnet{i}",
                vpc_id=vpc.ref,
                availability_zone=azs[i],
                cidr_block=f"10.42.{16 * i}.0/20",
                map_public_ip_on_launch=True,
                tags=[{"key": "Name", "value": f"{project}-public-{i}"}],
            )
            for i in range(2)
        ]
        private_subnets = [
            ec2.CfnSubnet(
                self,
                f"PrivateSubnet{i}",
                vpc_id=vpc.ref,
                availability_zone=azs[i],
                cidr_block=f"10.42.{128 + 16 * i}.0/20",
                tags=[{"key": "Name", "value": f"{project}-private-{i}"}],
            )
            for i in range(2)
        ]
        nat_eip = ec2.CfnEIP(self, "NatEip", domain="vpc")
        nat = ec2.CfnNatGateway(
            self, "Nat", allocation_id=nat_eip.attr_allocation_id, subnet_id=public_subnets[0].ref
        )
        nat.add_dependency(igw_attach)
        public_rt = ec2.CfnRouteTable(self, "PublicRouteTable", vpc_id=vpc.ref)
        ec2.CfnRoute(
            self, "PublicDefaultRoute", route_table_id=public_rt.ref, destination_cidr_block="0.0.0.0/0", gateway_id=igw.ref
        ).add_dependency(igw_attach)
        private_rt = ec2.CfnRouteTable(self, "PrivateRouteTable", vpc_id=vpc.ref)
        ec2.CfnRoute(
            self,
            "PrivateDefaultRoute",
            route_table_id=private_rt.ref,
            destination_cidr_block="0.0.0.0/0",
            nat_gateway_id=nat.ref,
        )
        for i, sn in enumerate(public_subnets):
            ec2.CfnSubnetRouteTableAssociation(self, f"PublicRta{i}", subnet_id=sn.ref, route_table_id=public_rt.ref)
        for i, sn in enumerate(private_subnets):
            ec2.CfnSubnetRouteTableAssociation(self, f"PrivateRta{i}", subnet_id=sn.ref, route_table_id=private_rt.ref)

        # The L2 view of the same network, for the constructs that need an IVpc.
        # from_vpc_attributes creates nothing — it is a typed handle.
        ivpc = ec2.Vpc.from_vpc_attributes(
            self,
            "VpcRef",
            vpc_id=vpc.ref,
            availability_zones=azs,
            public_subnet_ids=[s.ref for s in public_subnets],
            private_subnet_ids=[s.ref for s in private_subnets],
        )
        public_sel = ec2.SubnetSelection(subnets=[ec2.Subnet.from_subnet_id(self, f"PubRef{i}", s.ref) for i, s in enumerate(public_subnets)])
        private_sel = ec2.SubnetSelection(subnets=[ec2.Subnet.from_subnet_id(self, f"PrivRef{i}", s.ref) for i, s in enumerate(private_subnets)])

        # --------------------------------------------------------- security --
        # security.tf. Inline ingress/egress on the group, as Terraform wrote
        # them, so the imported group's rule set matches instead of gaining a
        # second copy of each rule as separate CfnSecurityGroupIngress rows.
        def cf_ingress(port: int, description: str) -> dict[str, Any]:
            rule: dict[str, Any] = {"ipProtocol": "tcp", "fromPort": port, "toPort": port, "description": description}
            if restrict_to_cloudfront and cloudfront_prefix_list:
                rule["sourcePrefixListId"] = cloudfront_prefix_list
            else:
                rule["cidrIp"] = "0.0.0.0/0"
            return rule

        all_egress = [{"ipProtocol": "-1", "cidrIp": "0.0.0.0/0"}]
        alb_ingress = [cf_ingress(443, "HTTPS from CloudFront")]
        if not alb_tls:
            alb_ingress.append(cf_ingress(80, "HTTP - the origin itself when no certificate is set"))
        alb_sg = ec2.CfnSecurityGroup(
            self,
            "AlbSg",
            group_name=sg_names["alb"],
            group_description="Managed by Terraform",  # create-only; Terraform's default, and the live value
            vpc_id=vpc.ref,
            security_group_ingress=alb_ingress,
            security_group_egress=all_egress,
        )
        api_sg = ec2.CfnSecurityGroup(
            self,
            "ApiSg",
            group_name=sg_names["api"],
            group_description="Managed by Terraform",  # create-only; Terraform's default, and the live value
            vpc_id=vpc.ref,
            security_group_ingress=[
                {"ipProtocol": "tcp", "fromPort": 3300, "toPort": 3300, "sourceSecurityGroupId": alb_sg.ref, "description": "uvicorn, from the ALB only"}
            ],
            security_group_egress=all_egress,
        )
        db_sg = ec2.CfnSecurityGroup(
            self,
            "DbSg",
            group_name=sg_names["db"],
            group_description="Managed by Terraform",  # create-only; Terraform's default, and the live value
            vpc_id=vpc.ref,
            security_group_ingress=[
                {"ipProtocol": "tcp", "fromPort": 5432, "toPort": 5432, "sourceSecurityGroupId": api_sg.ref, "description": "Postgres, from api tasks only"}
            ],
            security_group_egress=all_egress,
        )
        efs_sg = ec2.CfnSecurityGroup(
            self,
            "EfsSg",
            group_name=sg_names["efs"],
            group_description="Managed by Terraform",  # create-only; Terraform's default, and the live value
            vpc_id=vpc.ref,
            security_group_ingress=[
                {"ipProtocol": "tcp", "fromPort": 2049, "toPort": 2049, "sourceSecurityGroupId": api_sg.ref, "description": "NFS, from api tasks only"}
            ],
            security_group_egress=all_egress,
        )

        # ---------------------------------------------------------- storage --
        data_fs = efs.CfnFileSystem(
            self,
            "DataFs",
            encrypted=True,
            lifecycle_policies=[efs.CfnFileSystem.LifecyclePolicyProperty(transition_to_ia="AFTER_30_DAYS")],
            file_system_tags=[efs.CfnFileSystem.ElasticFileSystemTagProperty(key="Name", value=f"{project}-data")],
        )
        data_fs.apply_removal_policy(RemovalPolicy.RETAIN)
        for i, sn in enumerate(private_subnets):
            efs.CfnMountTarget(self, f"DataMount{i}", file_system_id=data_fs.ref, subnet_id=sn.ref, security_groups=[efs_sg.ref])
        data_ap = efs.CfnAccessPoint(
            self,
            "DataAccessPoint",
            file_system_id=data_fs.ref,
            posix_user=efs.CfnAccessPoint.PosixUserProperty(uid="1000", gid="1000"),
            root_directory=efs.CfnAccessPoint.RootDirectoryProperty(
                path="/reep-data",
                creation_info=efs.CfnAccessPoint.CreationInfoProperty(owner_uid="1000", owner_gid="1000", permissions="750"),
            ),
        )

        web_bucket = s3.Bucket(
            self,
            "WebBucket",
            bucket_name=web_bucket_name,
            versioned=True,
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            removal_policy=RemovalPolicy.RETAIN,
        )
        alb_logs_bucket = s3.Bucket(
            self,
            "AlbLogsBucket",
            bucket_name=alb_logs_bucket_name,
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            removal_policy=RemovalPolicy.RETAIN,
            lifecycle_rules=[s3.LifecycleRule(id="expire-90d", enabled=True, expiration=Duration.days(90))],
        )

        # ---------------------------------------------------------- secrets --
        # Imported by ARN, never created, never versioned here. See docstring.
        app_secret = sm.Secret.from_secret_complete_arn(self, "AppSecret", app_secret_arn)
        external_secret = sm.Secret.from_secret_complete_arn(self, "ExternalSecret", external_secret_arn)

        # ---------------------------------------------------------- logging --
        log_group = logs.LogGroup(
            self, "ApiLogs", log_group_name=f"/{project}/api", retention=logs.RetentionDays.ONE_MONTH, removal_policy=RemovalPolicy.RETAIN
        )
        alerts = sns.Topic(self, "Alerts", topic_name=f"{project}-alerts")
        if alert_email and harden:
            # An email subscription is import-hostile (CloudFormation cannot adopt
            # one), so it is created in the harden phase. SNS dedupes on
            # (topic, endpoint), so the existing subscription is reused rather
            # than doubled; a confirmation mail may arrive once more.
            alerts.add_subscription(subs.EmailSubscription(alert_email))

        # -------------------------------------------------------------- ecr --
        api_repo = ecr.CfnRepository(
            self,
            "ApiRepo",
            repository_name=f"{project}/api",
            image_tag_mutability="MUTABLE",
            image_scanning_configuration=ecr.CfnRepository.ImageScanningConfigurationProperty(scan_on_push=True),
            lifecycle_policy=ecr.CfnRepository.LifecyclePolicyProperty(
                lifecycle_policy_text=json.dumps(
                    {
                        "rules": [
                            {
                                "rulePriority": 1,
                                "description": "keep the last 20 images",
                                "selection": {"tagStatus": "any", "countType": "imageCountMoreThan", "countNumber": 20},
                                "action": {"type": "expire"},
                            }
                        ]
                    }
                )
            ),
        )
        api_repo.apply_removal_policy(RemovalPolicy.RETAIN)
        api_image = f"{self.account}.dkr.ecr.{self.region}.amazonaws.com/{project}/api:latest"

        # --------------------------------------------------------- database --
        db_subnets = rds.CfnDBSubnetGroup(
            self,
            "DbSubnets",
            db_subnet_group_name=f"{project}-db",
            db_subnet_group_description="Managed by Terraform",
            subnet_ids=[s.ref for s in private_subnets],
        )
        db = rds.CfnDBInstance(
            self,
            "Db",
            db_instance_identifier=f"{project}-postgres",
            engine="postgres",
            engine_version="17",
            db_instance_class=db_class,
            allocated_storage=allocated_storage,
            max_allocated_storage=100,
            storage_type="gp3",
            storage_encrypted=True,
            db_name="reep_py",
            master_username="reep",
            # NO master_user_password. Ever. See the module docstring and
            # tests/test_core_synth.py::test_no_master_password_in_the_template.
            multi_az=db_multi_az,
            db_subnet_group_name=db_subnets.ref,
            vpc_security_groups=[db_sg.ref],
            publicly_accessible=False,
            backup_retention_period=retention_days,
            preferred_backup_window="20:30-21:30",
            preferred_maintenance_window="sun:21:30-sun:22:30",
            deletion_protection=True,
            copy_tags_to_snapshot=True,
            enable_performance_insights=True,
            enable_cloudwatch_logs_exports=["postgresql"],
            auto_minor_version_upgrade=True,
        )
        # RETAIN, not SNAPSHOT. "Snapshot" means DELETE AFTER SNAPSHOTTING: a
        # delete-stack or cdk destroy would call DeleteDBInstance, held off only
        # by DeletionProtection — one toggled property from a new endpoint and
        # an invalid DATABASE_URL. Retain forgets the instance and touches it not.
        db.apply_removal_policy(RemovalPolicy.RETAIN)
        db_arn = f"arn:aws:rds:{self.region}:{self.account}:db:{project}-postgres"

        # ----------------------------------------------------------- backup --
        lock = None
        if harden:
            lock_kwargs: dict[str, Any] = {"min_retention_days": retention_days}
            if vault_lock_compliance:
                # Compliance mode: after 3 days NOBODY, including root, can
                # shorten retention or delete the vault. Irreversible; opt-in.
                lock_kwargs["changeable_for_days"] = 3
            lock = backup.CfnBackupVault.LockConfigurationTypeProperty(**lock_kwargs)
        vault = backup.CfnBackupVault(self, "Vault", backup_vault_name=f"{project}-vault", lock_configuration=lock)
        vault.apply_removal_policy(RemovalPolicy.RETAIN)
        backup_role = iam.Role(
            self,
            "BackupRole",
            role_name=f"{project}-backup",
            assumed_by=iam.ServicePrincipal("backup.amazonaws.com"),
            managed_policies=[
                iam.ManagedPolicy.from_aws_managed_policy_name("service-role/AWSBackupServiceRolePolicyForBackup"),
                *(
                    [iam.ManagedPolicy.from_aws_managed_policy_name("service-role/AWSBackupServiceRolePolicyForRestores")]
                    if harden
                    else []
                ),
            ],
        )
        rule = backup.CfnBackupPlan.BackupRuleResourceTypeProperty(
            rule_name=f"daily-{retention_days}d" if harden else "daily-35d",
            target_backup_vault=vault.attr_backup_vault_name,
            schedule_expression="cron(30 21 * * ? *)",  # 03:00 IST
            lifecycle=backup.CfnBackupPlan.LifecycleResourceTypeProperty(delete_after_days=retention_days if harden else 35),
            copy_actions=(
                [
                    backup.CfnBackupPlan.CopyActionResourceTypeProperty(
                        destination_backup_vault_arn=dr_vault_arn,
                        lifecycle=backup.CfnBackupPlan.LifecycleResourceTypeProperty(delete_after_days=retention_days),
                    )
                ]
                if harden and dr_vault_arn
                else None
            ),
        )
        plan = backup.CfnBackupPlan(
            self,
            "BackupPlan",
            backup_plan=backup.CfnBackupPlan.BackupPlanResourceTypeProperty(backup_plan_name=f"{project}-daily", backup_plan_rule=[rule]),
        )
        backup.CfnBackupSelection(
            self,
            "BackupSelection",
            backup_plan_id=plan.attr_backup_plan_id,
            backup_selection=backup.CfnBackupSelection.BackupSelectionResourceTypeProperty(
                selection_name=f"{project}-db-efs",
                iam_role_arn=backup_role.role_arn,
                resources=[db_arn, data_fs.attr_arn],
            ),
        )
        if harden:
            # A backup that has never been restored is a hope. Weekly, AWS
            # restores the newest recovery point into a throwaway instance,
            # checks it comes up, and deletes it. Failures raise the alarm below.
            rt_plan = backup.CfnRestoreTestingPlan(
                self,
                "RestoreTestingPlan",
                restore_testing_plan_name=f"{project}_weekly_restore",
                schedule_expression="cron(0 4 ? * SUN *)",  # 09:30 IST Sunday
                start_window_hours=4,
                recovery_point_selection=backup.CfnRestoreTestingPlan.RestoreTestingRecoveryPointSelectionProperty(
                    algorithm="LATEST_WITHIN_WINDOW",
                    include_vaults=[vault.attr_backup_vault_arn],
                    recovery_point_types=["SNAPSHOT", "CONTINUOUS"],
                    selection_window_days=7,
                ),
            )
            backup.CfnRestoreTestingSelection(
                self,
                "RestoreTestingSelectionDb",
                restore_testing_plan_name=rt_plan.ref,  # Ref is the plan NAME for this type
                restore_testing_selection_name=f"{project}_postgres",
                protected_resource_type="RDS",
                iam_role_arn=backup_role.role_arn,
                protected_resource_arns=[db_arn],
                validation_window_hours=1,
            )

        # -------------------------------------------------------------- iam --
        ecs_tasks = iam.ServicePrincipal("ecs-tasks.amazonaws.com")
        task_execution_role = iam.Role(
            self,
            "TaskExecutionRole",
            role_name=f"{project}-task-execution",
            assumed_by=ecs_tasks,
            managed_policies=[iam.ManagedPolicy.from_aws_managed_policy_name("service-role/AmazonECSTaskExecutionRolePolicy")],
            inline_policies={
                "read-app-secrets": iam.PolicyDocument(
                    statements=[
                        iam.PolicyStatement(
                            actions=["secretsmanager:GetSecretValue"],
                            resources=[app_secret.secret_arn, external_secret.secret_arn],
                        )
                    ]
                )
            },
        )
        task_statements = [
            iam.PolicyStatement(
                actions=[
                    "bedrock:InvokeModel",
                    "bedrock:InvokeModelWithResponseStream",
                    "bedrock:InvokeModelWithBidirectionalStream",
                ],
                resources=[
                    "arn:aws:bedrock:*::foundation-model/amazon.nova-*",
                    f"arn:aws:bedrock:*:{self.account}:inference-profile/*",
                ],
            )
        ]
        inline: dict[str, iam.PolicyDocument] = {"invoke-nova": iam.PolicyDocument(statements=task_statements)}
        if harden and ses_identity_domain:
            # Activation, reset and confirmation mail (app/mail_transport.py).
            # Scoped to the college's verified identity, and only from the
            # configured sender, so a compromised task cannot spoof the domain.
            inline["send-mail"] = iam.PolicyDocument(
                statements=[
                    iam.PolicyStatement(
                        actions=["ses:SendEmail", "ses:SendRawEmail"],
                        resources=[f"arn:aws:ses:{self.region}:{self.account}:identity/{ses_identity_domain}"],
                        conditions=(
                            {"StringEquals": {"ses:FromAddress": ses_from_address}} if ses_from_address else None
                        ),
                    )
                ]
            )
        api_task_role = iam.Role(self, "ApiTaskRole", role_name=f"{project}-api-task", assumed_by=ecs_tasks, inline_policies=inline)

        # -------------------------------------------------------------- alb --
        alb = elbv2.ApplicationLoadBalancer(
            self,
            "Alb",
            vpc=ivpc,
            internet_facing=True,
            load_balancer_name=f"{project}-alb",
            # mutable=False: the L2 must not append ingress rules to an imported
            # group. Without it, add_listener wrote a 0.0.0.0/0:80 rule the WAF is
            # there to prevent, and attach_to_application_target_group wrote a
            # duplicate of the inline :3300 rule — neither exists in reality.
            security_group=ec2.SecurityGroup.from_security_group_id(self, "AlbSgRef", alb_sg.ref, mutable=False),
            vpc_subnets=public_sel,
            idle_timeout=Duration.seconds(300),  # the interview WebSocket rides this listener
            drop_invalid_header_fields=True,
        )
        alb.log_access_logs(alb_logs_bucket)
        target_group = elbv2.ApplicationTargetGroup(
            self,
            "ApiTargetGroup",
            vpc=ivpc,
            target_group_name=f"{project}-api",
            port=3300,
            protocol=elbv2.ApplicationProtocol.HTTP,
            target_type=elbv2.TargetType.IP,
            health_check=elbv2.HealthCheck(
                path="/ready",
                interval=Duration.seconds(15),
                timeout=Duration.seconds(5),
                healthy_threshold_count=2,
                unhealthy_threshold_count=3,
                healthy_http_codes="200",
            ),
            deregistration_delay=Duration.seconds(DEREGISTRATION_DELAY_SECONDS if harden_ecs else 30),
        )
        listeners: list[elbv2.ApplicationListener] = []
        if alb_tls:
            listeners.append(
                alb.add_listener(
                    "HttpRedirect",
                    open=False,
                    port=80,
                    protocol=elbv2.ApplicationProtocol.HTTP,
                    # host/path/query are ELB's own defaults and the redirect
                    # behaves identically without them — but the LIVE listener
                    # reports them, so a mirror that omits them is a MODIFIED
                    # drift row at step 5 on a listener, which is the resource
                    # an operator is most likely to misread as a real error.
                    # Spelled out so the drift table stays short.
                    default_action=elbv2.ListenerAction.redirect(
                        host="#{host}", path="/#{path}", query="#{query}", port="443", protocol="HTTPS", permanent=True
                    ),
                )
            )
            listeners.append(
                alb.add_listener(
                    "Https",
                    open=False,
                    port=443,
                    protocol=elbv2.ApplicationProtocol.HTTPS,
                    certificates=[elbv2.ListenerCertificate.from_arn(alb_cert_arn)],
                    # alb.tf: ELBSecurityPolicy-TLS13-1-2-2021-06. That string is
                    # RECOMMENDED_TLS in the library; the first draft wrote
                    # `TLS13_12`, a member that does not exist, and no guard had
                    # synthesised this branch (none set a certificate), so the
                    # crash waited for the live context. test_core_synth.py now
                    # reads the policy out of alb.tf and synthesises this branch.
                    ssl_policy=elbv2.SslPolicy.RECOMMENDED_TLS,
                    default_target_groups=[target_group],
                )
            )
        else:
            listeners.append(
                alb.add_listener("HttpOrigin", open=False, port=80, protocol=elbv2.ApplicationProtocol.HTTP, default_target_groups=[target_group])
            )

        # -------------------------------------------------------------- ecs --
        cluster = ecs.Cluster(self, "Cluster", cluster_name=project, vpc=ivpc, container_insights=True)
        task_def = ecs.FargateTaskDefinition(
            self,
            "ApiTaskDef",
            family=f"{project}-api",
            cpu=api_cpu,
            memory_limit_mib=api_memory,
            # without_policy_updates: the secrets and log-driver helpers would
            # otherwise attach a generated AWS::IAM::Policy that exists nowhere
            # and cannot be imported. The inline read-app-secrets policy and the
            # managed execution policy already cover both.
            execution_role=task_execution_role.without_policy_updates(),
            task_role=api_task_role,
            volumes=[
                ecs.Volume(
                    name="data",
                    efs_volume_configuration=ecs.EfsVolumeConfiguration(
                        file_system_id=data_fs.ref,
                        transit_encryption="ENABLED",
                        authorization_config=ecs.AuthorizationConfig(access_point_id=data_ap.ref, iam="DISABLED"),
                    ),
                )
            ],
        )
        secrets = {
            "AUTH_SECRET": ecs.Secret.from_secrets_manager(app_secret, "AUTH_SECRET"),
            "DATABASE_URL": ecs.Secret.from_secrets_manager(app_secret, "DATABASE_URL"),
            "GOOGLE_CLIENT_ID": ecs.Secret.from_secrets_manager(external_secret, "GOOGLE_CLIENT_ID"),
            "GOOGLE_CLIENT_SECRET": ecs.Secret.from_secrets_manager(external_secret, "GOOGLE_CLIENT_SECRET"),
            "SENTRY_DSN": ecs.Secret.from_secrets_manager(external_secret, "SENTRY_DSN"),
            "VOICE_WORKER_SECRET": ecs.Secret.from_secrets_manager(external_secret, "VOICE_WORKER_SECRET"),
        }
        if harden_ecs and ses_from_address:
            api_environment["SES_FROM_ADDRESS"] = ses_from_address
        container = task_def.add_container(
            "api",
            image=ecs.ContainerImage.from_registry(api_image),
            essential=True,
            port_mappings=[ecs.PortMapping(container_port=3300, protocol=ecs.Protocol.TCP)],
            environment=api_environment,  # WEB_ORIGIN is added below, once the distribution exists
            secrets=secrets,
            logging=ecs.LogDrivers.aws_logs(log_group=log_group, stream_prefix="api"),
            stop_timeout=Duration.seconds(STOP_TIMEOUT_SECONDS) if harden_ecs else None,
        )
        container.add_mount_points(ecs.MountPoint(source_volume="data", container_path="/data", read_only=False))

        service = ecs.FargateService(
            self,
            "ApiService",
            service_name="api",
            cluster=cluster,
            task_definition=task_def,
            # No desired_count: Terraform ignores it after creation because
            # autoscaling owns it. Sending DesiredCount=2 on the harden update
            # would scale a busy day back to 2. cdk.json's
            # removeDefaultDesiredCount flag keeps the property out.
            security_groups=[ec2.SecurityGroup.from_security_group_id(self, "ApiSgRef", api_sg.ref, mutable=False)],
            vpc_subnets=private_sel,
            assign_public_ip=False,
            health_check_grace_period=Duration.seconds(60),
            circuit_breaker=ecs.DeploymentCircuitBreaker(enable=True, rollback=True),
            # 100/200: the old task is not stopped until the new one is healthy.
            #
            # NOT phase-conditional, and that is the fix for a real mirror
            # error (2026-09-07, found by the pre-import review). This read
            # `100 if harden_ecs else 50`, on the assumption that 50 was the
            # live value and 100 the improvement. **The live service is already
            # at 100** — `ecs.tf` never sets the property, so 100 is the ECS
            # default and the refresh recorded it. Rendering 50 in the import
            # phase would have produced a MODIFIED drift row the runbook does
            # not list, at the one checkpoint whose whole job is to be empty.
            # Worse: step 9a (`-c hardenEcs=false`) still flips this service's
            # ManagedBy tag, so CloudFormation updates the service and sends
            # the template's DeploymentConfiguration with it — lowering the
            # live minimum from 100 to 50 for the length of the Multi-AZ
            # conversion, which is exactly when losing a task hurts most.
            # Live and target are the same number, so the property now falls
            # out of every diff. `test_the_service_keeps_both_tasks_in_every_phase`
            # pins it in BOTH phases.
            min_healthy_percent=100,
            max_healthy_percent=200,
        )
        service.attach_to_application_target_group(target_group)
        for lst in listeners:
            service.node.add_dependency(lst)
        scaling = service.auto_scale_task_count(min_capacity=api_min, max_capacity=api_max)
        scaling.scale_on_cpu_utilization(
            "CpuTarget", target_utilization_percent=60, scale_in_cooldown=Duration.seconds(300), scale_out_cooldown=Duration.seconds(60)
        )
        scaling.scale_on_memory_utilization(
            "MemoryTarget", target_utilization_percent=75, scale_in_cooldown=Duration.seconds(300), scale_out_cooldown=Duration.seconds(60)
        )
        # Terraform named the policies; PolicyName is immutable, so the import
        # must present the same names. scale_on_* returns nothing in this
        # binding and parents the policy under the service's scaling target,
        # so the L1s are found by walking the stack and matched on the metric
        # each one tracks — unambiguous, and independent of CDK's tree layout.
        def _cfn_policy(predefined_metric: str) -> appscaling.CfnScalingPolicy:
            for child in self.node.find_all():
                if isinstance(child, appscaling.CfnScalingPolicy):
                    cfg = child.target_tracking_scaling_policy_configuration
                    spec = getattr(cfg, "predefined_metric_specification", None) if cfg is not None else None
                    if spec is not None and spec.predefined_metric_type == predefined_metric:
                        return child
            raise RuntimeError(f"no CfnScalingPolicy tracking {predefined_metric}")

        _cfn_policy("ECSServiceAverageCPUUtilization").add_property_override("PolicyName", "cpu-target")
        _cfn_policy("ECSServiceAverageMemoryUtilization").add_property_override("PolicyName", "memory-target")

        # The nightly retention job: the api image, one-off, `app.retention_job`.
        scheduler_role = iam.Role(
            self,
            "SchedulerRole",
            role_name=f"{project}-scheduler",
            assumed_by=iam.ServicePrincipal("scheduler.amazonaws.com"),
            inline_policies={
                "run-retention-task": iam.PolicyDocument(
                    statements=[
                        iam.PolicyStatement(
                            actions=["ecs:RunTask"],
                            resources=[f"arn:aws:ecs:{self.region}:{self.account}:task-definition/{project}-api:*"],
                        ),
                        iam.PolicyStatement(
                            actions=["iam:PassRole"], resources=[task_execution_role.role_arn, api_task_role.role_arn]
                        ),
                    ]
                )
            },
        )
        scheduler.CfnSchedule(
            self,
            "RetentionSchedule",
            name=f"{project}-retention-daily",
            schedule_expression="cron(30 21 * * ? *)",
            flexible_time_window=scheduler.CfnSchedule.FlexibleTimeWindowProperty(mode="OFF"),
            target=scheduler.CfnSchedule.TargetProperty(
                arn=cluster.cluster_arn,
                role_arn=scheduler_role.role_arn,
                ecs_parameters=scheduler.CfnSchedule.EcsParametersProperty(
                    task_definition_arn=task_def.task_definition_arn,
                    launch_type="FARGATE",
                    network_configuration=scheduler.CfnSchedule.NetworkConfigurationProperty(
                        awsvpc_configuration=scheduler.CfnSchedule.AwsVpcConfigurationProperty(
                            subnets=[s.ref for s in private_subnets], security_groups=[api_sg.ref], assign_public_ip="DISABLED"
                        )
                    ),
                ),
                input=json.dumps(
                    {"containerOverrides": [{"name": "api", "command": ["python", "-m", "app.retention_job"]}]},
                    separators=(",", ":"),
                    sort_keys=True,
                ),
            ),
        )

        # ------------------------------------------------------------- edge --
        spa_fallback = cloudfront.Function(
            self,
            "SpaFallback",
            function_name=f"{project}-spa-fallback",
            runtime=cloudfront.FunctionRuntime.JS_2_0,
            comment="Serve index.html for SPA routes. Never runs on /api/*.",
            code=cloudfront.FunctionCode.from_inline(_SPA_FALLBACK_JS),
            auto_publish=True,
        )
        oac = cloudfront.S3OriginAccessControl(
            self,
            "WebOac",
            origin_access_control_name=f"{project}-web",
            # The live OAC's description, which is the aws provider's default
            # when the argument is unset. Omitting it is a drift row at step 5
            # and a live write at step 9 that clears the field for nothing.
            description="Managed by Terraform",
            signing=cloudfront.Signing.SIGV4_ALWAYS,
        )
        api_origin_domain = alb_origin_domain or alb.load_balancer_dns_name
        distribution = cloudfront.Distribution(
            self,
            "Distribution",
            comment=f"{project} - SPA + /api",
            enable_ipv6=False,  # Terraform's default; CDK's is true, and it would flip on the next distribution update
            default_root_object="index.html",
            price_class=cloudfront.PriceClass.PRICE_CLASS_200,
            web_acl_id=waf_acl_arn or None,
            domain_names=[domain_name] if domain_name else None,
            certificate=(
                __import__("aws_cdk.aws_certificatemanager", fromlist=["Certificate"]).Certificate.from_certificate_arn(
                    self, "CfCert", cf_cert_arn
                )
                if domain_name and cf_cert_arn
                else None
            ),
            minimum_protocol_version=(
                # The live distribution was given its alias, certificate and this
                # policy in the console on 2026-09-02, outside Terraform; the
                # runbook's refresh recorded it and cdn.tf was edited to match.
                # The mirror says what is there, not what the first apply chose.
                cloudfront.SecurityPolicyProtocol.TLS_V1_3_2025 if domain_name else cloudfront.SecurityPolicyProtocol.TLS_V1
            ),
            default_behavior=cloudfront.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(web_bucket, origin_access_control=oac, origin_id="web-s3"),
                viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowed_methods=cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                cached_methods=cloudfront.CachedMethods.CACHE_GET_HEAD,
                cache_policy=cloudfront.CachePolicy.from_cache_policy_id(self, "CacheOptimized", _CACHE_OPTIMIZED),
                compress=True,
                function_associations=[
                    cloudfront.FunctionAssociation(function=spa_fallback, event_type=cloudfront.FunctionEventType.VIEWER_REQUEST)
                ],
            ),
            additional_behaviors={
                "/api/*": cloudfront.BehaviorOptions(
                    origin=origins.HttpOrigin(
                        api_origin_domain,
                        origin_id="api-alb",
                        protocol_policy=(
                            cloudfront.OriginProtocolPolicy.HTTPS_ONLY if alb_tls else cloudfront.OriginProtocolPolicy.HTTP_ONLY
                        ),
                        origin_ssl_protocols=[cloudfront.OriginSslPolicy.TLS_V1_2],
                        read_timeout=Duration.seconds(60),
                        http_port=80,
                        https_port=443,
                    ),
                    viewer_protocol_policy=cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                    allowed_methods=cloudfront.AllowedMethods.ALLOW_ALL,
                    cached_methods=cloudfront.CachedMethods.CACHE_GET_HEAD,
                    cache_policy=cloudfront.CachePolicy.from_cache_policy_id(self, "CacheDisabled", _CACHE_DISABLED),
                    origin_request_policy=cloudfront.OriginRequestPolicy.from_origin_request_policy_id(
                        self, "OriginAllViewer", _ORIGIN_ALL_VIEWER
                    ),
                    compress=True,
                ),
            },
        )
        web_origin = f"https://{domain_name}" if domain_name else f"https://{distribution.distribution_domain_name}"
        container.add_environment("WEB_ORIGIN", web_origin)

        # ----------------------------------------------------- observability --
        alarm_action = cw_actions.SnsAction(alerts)

        def alarm(cid: str, *, name: str, metric: cw.Metric, threshold: float, periods: int, op: cw.ComparisonOperator,
                  missing: cw.TreatMissingData | None = None, description: str | None = None, ok: bool = False) -> cw.Alarm:
            a = cw.Alarm(
                self, cid, alarm_name=name, alarm_description=description, metric=metric, threshold=threshold,
                evaluation_periods=periods, comparison_operator=op, treat_missing_data=missing,
            )
            a.add_alarm_action(alarm_action)
            if ok:
                a.add_ok_action(alarm_action)
            return a

        dropped = logs.MetricFilter(
            self,
            "DroppedTurnsFilter",
            log_group=log_group,
            filter_name="interview-dropped-turns",
            filter_pattern=logs.FilterPattern.literal('"Dropped interview turn"'),
            metric_namespace="REEP/AI",
            metric_name="DroppedInterviewTurns",
            metric_value="1",
            default_value=0,
        )
        alarm(
            "DroppedTurnsAlarm",
            name=f"{project}-interview-dropped-turns",
            description="Interview turns are being dropped - conversations sound fine and save nothing. See the voice runbook in AGENTS.md.",
            metric=dropped.metric(statistic="Sum", period=Duration.minutes(5)),
            threshold=1, periods=1, op=cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
            missing=cw.TreatMissingData.NOT_BREACHING,
        )
        alarm(
            "Alb5xxAlarm",
            name=f"{project}-alb-5xx",
            metric=cw.Metric(namespace="AWS/ApplicationELB", metric_name="HTTPCode_Target_5XX_Count", statistic="Sum",
                             period=Duration.minutes(5), dimensions_map={"LoadBalancer": alb.load_balancer_full_name}),
            threshold=10, periods=1, op=cw.ComparisonOperator.GREATER_THAN_THRESHOLD, missing=cw.TreatMissingData.NOT_BREACHING,
        )
        alarm(
            "NoHealthyApiAlarm",
            name=f"{project}-no-healthy-api",
            description="Fewer than one healthy api task behind the ALB - the dashboard is down.",
            metric=cw.Metric(namespace="AWS/ApplicationELB", metric_name="HealthyHostCount", statistic="Minimum",
                             period=Duration.minutes(1),
                             dimensions_map={"LoadBalancer": alb.load_balancer_full_name, "TargetGroup": target_group.target_group_full_name}),
            threshold=1, periods=3, op=cw.ComparisonOperator.LESS_THAN_THRESHOLD, missing=cw.TreatMissingData.BREACHING, ok=True,
        )
        alarm(
            "RdsStorageAlarm",
            name=f"{project}-rds-low-storage",
            metric=cw.Metric(namespace="AWS/RDS", metric_name="FreeStorageSpace", statistic="Minimum", period=Duration.minutes(5),
                             dimensions_map={"DBInstanceIdentifier": f"{project}-postgres"}),
            threshold=5 * 1024 * 1024 * 1024, periods=1, op=cw.ComparisonOperator.LESS_THAN_THRESHOLD,
        )
        alarm(
            "RdsCpuAlarm",
            name=f"{project}-rds-cpu",
            metric=cw.Metric(namespace="AWS/RDS", metric_name="CPUUtilization", statistic="Average", period=Duration.minutes(5),
                             dimensions_map={"DBInstanceIdentifier": f"{project}-postgres"}),
            threshold=85, periods=2, op=cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        )
        alarm(
            "ApiCpuPeggedAlarm",
            name=f"{project}-api-cpu-at-max",
            description="CPU high while autoscaling should have absorbed it - likely at api_max_tasks. Raise the ceiling or find the hot path in Sentry.",
            metric=cw.Metric(namespace="AWS/ECS", metric_name="CPUUtilization", statistic="Average", period=Duration.minutes(5),
                             dimensions_map={"ClusterName": project, "ServiceName": "api"}),
            threshold=85, periods=3, op=cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        )
        if harden:
            # The backup that silently stopped happening is the one that hurts —
            # and a backup, a copy and a restore test are three different jobs
            # with three different failure metrics.
            for cid, suffix, metric_name, what in (
                ("BackupJobsFailedAlarm", "backup-job-failed", "NumberOfBackupJobsFailed", "daily snapshot"),
                ("CopyJobsFailedAlarm", "backup-copy-failed", "NumberOfCopyJobsFailed", "cross-region copy to ap-southeast-1"),
                ("RestoreJobsFailedAlarm", "backup-restore-test-failed", "NumberOfRestoreJobsFailed", "weekly restore test"),
            ):
                alarm(
                    cid,
                    name=f"{project}-{suffix}",
                    description=f"An AWS Backup {what} job failed. Check the Backup console before the next one runs.",
                    metric=cw.Metric(namespace="AWS/Backup", metric_name=metric_name, statistic="Sum",
                                     period=Duration.hours(24), dimensions_map={"BackupVaultName": f"{project}-vault"}),
                    threshold=1, periods=1, op=cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
                    missing=cw.TreatMissingData.NOT_BREACHING,
                )

        observer_principal_obj: iam.IPrincipal = (
            iam.ArnPrincipal(observer_principal) if observer_principal else iam.AccountRootPrincipal()
        )
        iam.Role(
            self,
            "ClaudeObserverRole",
            role_name=f"{project}-claude-observer",
            assumed_by=observer_principal_obj,
            inline_policies={
                "read-only-diagnosis": iam.PolicyDocument(
                    statements=[
                        iam.PolicyStatement(
                            actions=[
                                "cloudwatch:Get*", "cloudwatch:List*", "cloudwatch:Describe*",
                                "logs:Get*", "logs:Describe*", "logs:FilterLogEvents",
                                "logs:StartQuery", "logs:GetQueryResults", "logs:StopQuery",
                                "ecs:Describe*", "ecs:List*",
                                "rds:Describe*",
                                "elasticloadbalancing:Describe*",
                                "application-autoscaling:Describe*",
                            ],
                            resources=["*"],
                        )
                    ]
                )
            },
        )

        # --------------------------------------------------------- github --
        if github_oidc_arn:
            # The account already has the provider (Terraform's
            # create_github_oidc_provider=false, or it predates REEP): reference
            # it, never declare a second one — an account has one per URL.
            oidc_arn = github_oidc_arn
        else:
            oidc = iam.CfnOIDCProvider(
                self,
                "GithubOidc",
                url="https://token.actions.githubusercontent.com",
                client_id_list=["sts.amazonaws.com"],
                thumbprint_list=["6938fd4d98bab03faadb97b34396831e3780aea1"],
            )
            oidc_arn = oidc.attr_arn
        subjects = [f"repo:{gh_repo}:ref:{gh_ref}"]
        if gh_repo_ids:
            subjects.insert(0, f"repo:{gh_repo_ids}:ref:{gh_ref}")
        deploy_role = iam.Role(
            self,
            "GithubDeployRole",
            role_name=f"{project}-github-deploy",
            assumed_by=iam.FederatedPrincipal(
                oidc_arn,
                conditions={
                    "StringEquals": {
                        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                        "token.actions.githubusercontent.com:sub": subjects,
                    }
                },
                assume_role_action="sts:AssumeRoleWithWebIdentity",
            ),
            inline_policies={
                "deploy-api-and-spa": iam.PolicyDocument(
                    statements=[
                        iam.PolicyStatement(sid="EcrLogin", actions=["ecr:GetAuthorizationToken"], resources=["*"]),
                        iam.PolicyStatement(
                            sid="PushTheApiImage",
                            actions=[
                                "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
                                "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages",
                            ],
                            resources=[api_repo.attr_arn],
                        ),
                        iam.PolicyStatement(sid="RollTheService", actions=["ecs:UpdateService", "ecs:DescribeServices"], resources=[service.service_arn]),
                        iam.PolicyStatement(
                            sid="RunOneOffTasks",
                            actions=["ecs:RunTask"],
                            resources=[f"arn:aws:ecs:{self.region}:{self.account}:task-definition/{project}-api:*"],
                            conditions={"ArnEquals": {"ecs:cluster": cluster.cluster_arn}},
                        ),
                        iam.PolicyStatement(sid="WatchThoseTasks", actions=["ecs:DescribeTasks", "ecs:DescribeTaskDefinition"], resources=["*"]),
                        iam.PolicyStatement(
                            sid="HandTheTaskItsRoles",
                            actions=["iam:PassRole"],
                            resources=[task_execution_role.role_arn, api_task_role.role_arn],
                            conditions={"StringEquals": {"iam:PassedToService": "ecs-tasks.amazonaws.com"}},
                        ),
                        iam.PolicyStatement(sid="PublishTheSpa", actions=["s3:ListBucket"], resources=[web_bucket.bucket_arn]),
                        iam.PolicyStatement(sid="WriteTheSpa", actions=["s3:PutObject", "s3:DeleteObject", "s3:GetObject"], resources=[web_bucket.arn_for_objects("*")]),
                        iam.PolicyStatement(
                            sid="BustTheCache",
                            actions=["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
                            resources=[f"arn:aws:cloudfront::{self.account}:distribution/{distribution.distribution_id}"],
                        ),
                    ]
                )
            },
        )

        # ---------------------------------------------------------- outputs --
        CfnOutput(self, "Phase", value=self.phase)
        CfnOutput(self, "CloudfrontDomain", value=distribution.distribution_domain_name)
        CfnOutput(self, "CloudfrontDistributionId", value=distribution.distribution_id)
        CfnOutput(self, "AlbDnsName", value=alb.load_balancer_dns_name)
        CfnOutput(self, "WebBucketName", value=web_bucket.bucket_name)
        CfnOutput(self, "EcsCluster", value=cluster.cluster_name)
        CfnOutput(self, "DbEndpoint", value=db.attr_endpoint_address)
        CfnOutput(self, "GithubDeployRoleArn", value=deploy_role.role_arn)
        CfnOutput(self, "BackupVaultArn", value=vault.attr_backup_vault_arn)

        self.distribution = distribution
        self.service = service
        self.db = db
        self.vault = vault
