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


def test_uploads_is_versioned_and_recordings_deliberately_is_not() -> None:
    """Versioning is a data-loss guard on one bucket and a privacy leak on the other.

    Neither bucket is in any backup plan — the plan's single selection covers
    the database and EFS and nothing in S3 — so an overwritten candidate roster
    in `uploads` had no second copy anywhere. Versioning fixes that.

    `recordings` must NOT follow. It expires student voice on a clock the
    student consented to, and on a versioned bucket a lifecycle expiration only
    writes a delete marker: the audio survives as a non-current version. Turning
    versioning on there would silently keep student voice past its retention,
    which is the one thing the recording design promises it will not do. This
    asserts the asymmetry so a later "make the buckets consistent" tidy-up has
    to read this docstring first.
    """
    t = _template()
    buckets = t.find_resources("AWS::S3::Bucket")
    versioned = {
        logical_id: body.get("Properties", {}).get("VersioningConfiguration", {}).get("Status")
        for logical_id, body in buckets.items()
    }
    by_role = {
        ("recordings" if "LifecycleConfiguration" in body.get("Properties", {}) else "uploads"): logical_id
        for logical_id, body in buckets.items()
    }
    assert versioned[by_role["uploads"]] == "Enabled", "the uploads bucket is the only copy of a candidate roster"
    assert versioned.get(by_role["recordings"]) is None, (
        "the recordings bucket must stay unversioned — a non-current version outlives the "
        "lifecycle delete marker, so versioning keeps student audio past its consented retention"
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


def test_no_opensearch_collection_comes_back() -> None:
    """The collection was REMOVED in 2026-09 and must not return by accident.

    It cost $361/month — 73% of the account's entire bill — and nothing read it.
    `OpenSearchIndex.search` and `.knn` had zero callers, and the session-log
    writer passed raw datetimes into `json.dumps`, so every write raised
    TypeError, was swallowed by "a projection never fails the call", and left
    `opensearch_synced` false for the life of the feature.

    This is a cost guard, not a style guard: an AOSS collection bills a minimum
    capacity floor whether or not a single document is ever indexed, so one
    re-added construct is $361/month with no error message anywhere.
    """
    t = _template()
    for kind in (
        "AWS::OpenSearchServerless::Collection",
        "AWS::OpenSearchServerless::SecurityPolicy",
        "AWS::OpenSearchServerless::AccessPolicy",
    ):
        t.resource_count_is(kind, 0)


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
            "PLATFORM_DYNAMO_PG_TABLE", "PLATFORM_CLOUDWATCH_NAMESPACE",
        )
    }
