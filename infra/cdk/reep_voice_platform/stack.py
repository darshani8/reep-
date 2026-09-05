"""The voice-assistant platform's AWS resources, as one CDK stack.

    S3 uploads bucket  -> Lambda (validate) -> SQS ug / SQS pg (+ DLQs)
    S3 recordings bucket <- the api's call-close handler (dual-channel WAV/MP3)
    DynamoDB ug / pg tables <- realtime session state
    OpenSearch Serverless (VECTORSEARCH) <- session logs + question vectors
    IAM: one policy attached to the EXISTING api task role
    SSM: /<project>/voice-platform/PLATFORM_* — the api's environment

WHAT THIS STACK DOES NOT OWN. The VPC, the ALB, the ECS service, the database
and the api task role are the Terraform stack in infra/aws/ and stay there —
they are live and this stack is additive. It imports the task role BY NAME
(`<project>-api-task`, ecs.tf) and attaches a policy; it never redefines the
role. The PLATFORM_* values reach the api task through SSM Parameter Store:
this stack writes them, infra/aws/voice_platform_bridge.tf reads them into the
task definition when `voice_platform_enabled = true`. One direction, no cycle.

EVERY PIECE IS OPTIONAL TO THE API. A deployment without this stack runs the
platform's Admin CRUD with in-memory session state and local recordings, and
GET /api/platform/admin/status says so. Deploying this stack is what turns the
projections on.

The Lambda is the queue/ package directory of the api, zipped as-is: it imports
only the standard library and boto3 (see app/voice_platform/queue/__init__.py),
so there is no bundling step and no Docker.
"""

from __future__ import annotations

import json
from pathlib import Path

from aws_cdk import (
    CfnOutput,
    Duration,
    RemovalPolicy,
    Stack,
    aws_dynamodb as ddb,
    aws_iam as iam,
    aws_lambda as _lambda,
    aws_opensearchserverless as aoss,
    aws_s3 as s3,
    aws_s3_notifications as s3n,
    aws_sqs as sqs,
    aws_ssm as ssm,
)
from constructs import Construct

DEGREE_LEVELS = ("UG", "PG")

#: The queue package, relative to this file: infra/cdk/reep_voice_platform/ ->
#: apps/api-py/app/voice_platform/queue.
QUEUE_PACKAGE_DIR = (
    Path(__file__).resolve().parents[3] / "apps" / "api-py" / "app" / "voice_platform" / "queue"
)


class VoicePlatformStack(Stack):
    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        *,
        project: str = "reep",
        api_task_role_name: str | None = None,
        recording_retention_days: int = 180,
        lambda_code_path: Path | None = None,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)
        prefix = f"{project}-voice"
        role_name = api_task_role_name or f"{project}-api-task"

        # --- S3 -------------------------------------------------------------
        uploads = s3.Bucket(
            self,
            "Uploads",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            removal_policy=RemovalPolicy.RETAIN,
        )
        recordings = s3.Bucket(
            self,
            "Recordings",
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            encryption=s3.BucketEncryption.S3_MANAGED,
            enforce_ssl=True,
            removal_policy=RemovalPolicy.RETAIN,
            # Student voice is deleted on a clock, like the per-speaker WAVs on
            # EFS. Mirror the per-degree recording policy's retention_days; the
            # shorter of the two wins.
            lifecycle_rules=[
                s3.LifecycleRule(
                    id="expire-recordings",
                    prefix="recordings/",
                    expiration=Duration.days(int(recording_retention_days)),
                )
            ],
        )

        # --- SQS: one stream per degree level, each with a DLQ ------------
        queues: dict[str, sqs.Queue] = {}
        for degree in DEGREE_LEVELS:
            dlq = sqs.Queue(
                self,
                f"Candidates{degree}Dlq",
                queue_name=f"{prefix}-candidates-{degree.lower()}-dlq",
                # 14 days: long enough for a human to read what could not be stored.
                retention_period=Duration.days(14),
                encryption=sqs.QueueEncryption.SQS_MANAGED,
            )
            queues[degree] = sqs.Queue(
                self,
                f"Candidates{degree}",
                queue_name=f"{prefix}-candidates-{degree.lower()}",
                visibility_timeout=Duration.seconds(60),
                retention_period=Duration.days(4),
                encryption=sqs.QueueEncryption.SQS_MANAGED,
                dead_letter_queue=sqs.DeadLetterQueue(max_receive_count=5, queue=dlq),
            )

        # --- Lambda: validate the upload, push to the right stream -----------
        ingest = _lambda.Function(
            self,
            "CandidateIngest",
            function_name=f"{prefix}-candidate-ingest",
            runtime=_lambda.Runtime.PYTHON_3_12,
            handler="lambda_handler.handler",
            code=_lambda.Code.from_asset(
                str(lambda_code_path or QUEUE_PACKAGE_DIR),
                exclude=["__pycache__", "*.pyc", "worker.py"],
            ),
            timeout=Duration.seconds(120),
            memory_size=512,
            environment={
                "PLATFORM_UG_QUEUE_URL": queues["UG"].queue_url,
                "PLATFORM_PG_QUEUE_URL": queues["PG"].queue_url,
                "PLATFORM_REJECTS_PREFIX": "rejects/",
            },
        )
        uploads.grant_read(ingest)
        uploads.grant_put(ingest, "rejects/*")
        for queue in queues.values():
            queue.grant_send_messages(ingest)
        uploads.add_event_notification(
            s3.EventType.OBJECT_CREATED,
            s3n.LambdaDestination(ingest),
            s3.NotificationKeyFilter(prefix="uploads/"),
        )

        # --- DynamoDB: realtime session state, one table per degree level ----
        tables: dict[str, ddb.Table] = {}
        for degree in DEGREE_LEVELS:
            tables[degree] = ddb.Table(
                self,
                f"Sessions{degree}",
                table_name=f"{prefix}-sessions-{degree.lower()}",
                partition_key=ddb.Attribute(name="session_id", type=ddb.AttributeType.STRING),
                billing_mode=ddb.BillingMode.PAY_PER_REQUEST,
                time_to_live_attribute="expires_at",
                encryption=ddb.TableEncryption.AWS_MANAGED,
                point_in_time_recovery_specification=ddb.PointInTimeRecoverySpecification(
                    point_in_time_recovery_enabled=True
                ),
                removal_policy=RemovalPolicy.RETAIN,
            )

        # --- The api task role: imported, never redefined ----------------------
        api_role = iam.Role.from_role_name(self, "ApiTaskRole", role_name)

        # --- OpenSearch Serverless: session logs + question vectors ------------
        collection_name = prefix
        encryption = aoss.CfnSecurityPolicy(
            self,
            "SearchEncryption",
            name=f"{prefix}-enc",
            type="encryption",
            policy=json.dumps(
                {
                    "Rules": [{"ResourceType": "collection", "Resource": [f"collection/{collection_name}"]}],
                    "AWSOwnedKey": True,
                }
            ),
        )
        network = aoss.CfnSecurityPolicy(
            self,
            "SearchNetwork",
            name=f"{prefix}-net",
            type="network",
            # Reached from the api tasks inside the VPC. Public endpoint access is
            # the simplest working default for Serverless; a VPC endpoint
            # (CfnVpcEndpoint) tightens it later without a code change.
            policy=json.dumps(
                [
                    {
                        "Rules": [
                            {"ResourceType": "collection", "Resource": [f"collection/{collection_name}"]},
                            {"ResourceType": "dashboard", "Resource": [f"collection/{collection_name}"]},
                        ],
                        "AllowFromPublic": True,
                    }
                ]
            ),
        )
        collection = aoss.CfnCollection(
            self, "Search", name=collection_name, type="VECTORSEARCH"
        )
        collection.node.add_dependency(encryption)
        collection.node.add_dependency(network)
        aoss.CfnAccessPolicy(
            self,
            "SearchAccess",
            name=f"{prefix}-access",
            type="data",
            policy=json.dumps(
                [
                    {
                        "Rules": [
                            {
                                "ResourceType": "index",
                                "Resource": [f"index/{collection_name}/*"],
                                "Permission": [
                                    "aoss:CreateIndex",
                                    "aoss:DescribeIndex",
                                    "aoss:UpdateIndex",
                                    "aoss:ReadDocument",
                                    "aoss:WriteDocument",
                                ],
                            },
                            {
                                "ResourceType": "collection",
                                "Resource": [f"collection/{collection_name}"],
                                "Permission": ["aoss:DescribeCollectionItems"],
                            },
                        ],
                        "Principal": [api_role.role_arn],
                    }
                ]
            ),
        )

        # --- What the api task may do --------------------------------------------
        iam.Policy(
            self,
            "ApiVoicePlatform",
            policy_name="voice-platform",
            roles=[api_role],
            statements=[
                iam.PolicyStatement(
                    actions=["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
                    resources=[recordings.arn_for_objects("*"), uploads.arn_for_objects("*")],
                ),
                iam.PolicyStatement(
                    actions=[
                        "sqs:SendMessage",
                        "sqs:ReceiveMessage",
                        "sqs:DeleteMessage",
                        "sqs:GetQueueAttributes",
                    ],
                    resources=[q.queue_arn for q in queues.values()],
                ),
                iam.PolicyStatement(
                    actions=["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem", "dynamodb:Query"],
                    resources=[t.table_arn for t in tables.values()],
                ),
                iam.PolicyStatement(actions=["aoss:APIAccessAll"], resources=[collection.attr_arn]),
                iam.PolicyStatement(
                    actions=["cloudwatch:PutMetricData"],
                    resources=["*"],
                    conditions={"StringEquals": {"cloudwatch:namespace": "REEP/VoicePlatform"}},
                ),
            ],
        )

        # --- The api's environment, via SSM ----------------------------------------
        env = {
            "PLATFORM_AWS_REGION": self.region,
            "PLATFORM_UG_QUEUE_URL": queues["UG"].queue_url,
            "PLATFORM_PG_QUEUE_URL": queues["PG"].queue_url,
            "PLATFORM_BULK_UPLOAD_BUCKET": uploads.bucket_name,
            "PLATFORM_RECORDINGS_BUCKET": recordings.bucket_name,
            "PLATFORM_DYNAMO_UG_TABLE": tables["UG"].table_name,
            "PLATFORM_DYNAMO_PG_TABLE": tables["PG"].table_name,
            "PLATFORM_OPENSEARCH_ENDPOINT": collection.attr_collection_endpoint,
            "PLATFORM_CLOUDWATCH_NAMESPACE": "REEP/VoicePlatform",
        }
        for name, value in env.items():
            ssm.StringParameter(
                self,
                f"Param{name}",
                parameter_name=f"/{project}/voice-platform/{name}",
                string_value=value,
                description=f"voice platform: {name} (read by infra/aws/voice_platform_bridge.tf)",
            )
            CfnOutput(self, name, value=value)

        self.uploads = uploads
        self.recordings = recordings
        self.queues = queues
        self.tables = tables
        self.collection = collection
        self.ingest = ingest
