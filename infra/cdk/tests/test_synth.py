"""The stack synthesises, and the template has the shape the api expects."""

from __future__ import annotations

import aws_cdk as cdk
from aws_cdk.assertions import Match, Template

from reep_voice_platform import VoicePlatformStack


def _template() -> Template:
    app = cdk.App()
    stack = VoicePlatformStack(
        app,
        "test-voice-platform",
        project="reep",
        recording_retention_days=90,
        env=cdk.Environment(account="123456789012", region="ap-south-1"),
    )
    return Template.from_stack(stack)


def test_two_streams_each_with_a_dead_letter_queue() -> None:
    t = _template()
    t.resource_count_is("AWS::SQS::Queue", 4)
    for degree in ("ug", "pg"):
        t.has_resource_properties(
            "AWS::SQS::Queue",
            {
                "QueueName": f"reep-voice-candidates-{degree}",
                "VisibilityTimeout": 60,
                "RedrivePolicy": Match.object_like({"maxReceiveCount": 5}),
            },
        )


def test_two_session_tables_keyed_on_session_id_with_ttl() -> None:
    t = _template()
    t.resource_count_is("AWS::DynamoDB::Table", 2)
    t.has_resource_properties(
        "AWS::DynamoDB::Table",
        {
            "TableName": "reep-voice-sessions-ug",
            "KeySchema": [{"AttributeName": "session_id", "KeyType": "HASH"}],
            "BillingMode": "PAY_PER_REQUEST",
            "TimeToLiveSpecification": {"AttributeName": "expires_at", "Enabled": True},
        },
    )


def test_recordings_bucket_is_private_encrypted_and_expires_on_a_clock() -> None:
    t = _template()
    t.resource_count_is("AWS::S3::Bucket", 2)
    t.has_resource_properties(
        "AWS::S3::Bucket",
        {
            "PublicAccessBlockConfiguration": Match.object_like({"BlockPublicAcls": True, "RestrictPublicBuckets": True}),
            "LifecycleConfiguration": {
                "Rules": [Match.object_like({"Prefix": "recordings/", "ExpirationInDays": 90, "Status": "Enabled"})]
            },
        },
    )


def test_the_lambda_is_the_queue_package_with_both_queue_urls() -> None:
    t = _template()
    t.has_resource_properties(
        "AWS::Lambda::Function",
        {
            "FunctionName": "reep-voice-candidate-ingest",
            "Handler": "lambda_handler.handler",
            "Runtime": "python3.12",
            "Environment": {
                "Variables": Match.object_like(
                    {"PLATFORM_UG_QUEUE_URL": Match.any_value(), "PLATFORM_PG_QUEUE_URL": Match.any_value(), "PLATFORM_REJECTS_PREFIX": "rejects/"}
                )
            },
        },
    )
    # The S3 notification is wired through the custom resource CDK emits.
    t.resource_count_is("Custom::S3BucketNotifications", 1)


def test_opensearch_collection_is_vectorsearch_with_its_three_policies() -> None:
    t = _template()
    t.has_resource_properties("AWS::OpenSearchServerless::Collection", {"Name": "reep-voice", "Type": "VECTORSEARCH"})
    t.resource_count_is("AWS::OpenSearchServerless::SecurityPolicy", 2)
    t.resource_count_is("AWS::OpenSearchServerless::AccessPolicy", 1)


def test_the_api_task_role_is_imported_and_granted_not_redefined() -> None:
    t = _template()
    # No role of the api's own is created here: the policy attaches to the
    # Terraform-owned role by name.
    roles = t.find_resources("AWS::IAM::Role")
    for props in roles.values():
        principal = props["Properties"]["AssumeRolePolicyDocument"]["Statement"][0]["Principal"]
        assert principal == {"Service": "lambda.amazonaws.com"}, principal
        assert props["Properties"].get("RoleName") != "reep-api-task"
    t.has_resource_properties(
        "AWS::IAM::Policy",
        {"PolicyName": "voice-platform", "Roles": ["reep-api-task"]},
    )
    t.has_resource_properties(
        "AWS::IAM::Policy",
        {"PolicyName": "deploy-cdk-stacks", "Roles": ["reep-github-deploy"]},
    )


def test_the_api_may_read_its_settings_path_and_the_deploy_role_the_bootstrap_roles() -> None:
    t = _template()
    policies = t.find_resources("AWS::IAM::Policy")
    by_name = {p["Properties"]["PolicyName"]: p["Properties"]["PolicyDocument"]["Statement"] for p in policies.values()}
    api = by_name["voice-platform"]
    ssm_stmt = next(s for s in api if "ssm:GetParametersByPath" in s["Action"])
    assert any("reep/voice-platform" in str(r) for r in ssm_stmt["Resource"])
    deploy = by_name["deploy-cdk-stacks"]
    assume = next(s for s in deploy if s["Action"] == "sts:AssumeRole")
    assert "cdk-hnb659fds-*" in str(assume["Resource"])


def test_every_platform_setting_is_published_to_ssm() -> None:
    t = _template()
    names = {
        p["Properties"]["Name"] for p in t.find_resources("AWS::SSM::Parameter").values()
    }
    assert names == {
        f"/reep/voice-platform/{k}"
        for k in (
            "PLATFORM_AWS_REGION", "PLATFORM_UG_QUEUE_URL", "PLATFORM_PG_QUEUE_URL",
            "PLATFORM_BULK_UPLOAD_BUCKET", "PLATFORM_RECORDINGS_BUCKET", "PLATFORM_DYNAMO_UG_TABLE",
            "PLATFORM_DYNAMO_PG_TABLE", "PLATFORM_OPENSEARCH_ENDPOINT", "PLATFORM_CLOUDWATCH_NAMESPACE",
        )
    }
