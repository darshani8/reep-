#!/usr/bin/env python3
"""CDK entry point. Context (cdk.json or `-c key=value`):

    project                  name prefix, and the Terraform stack's project (default reep)
    apiTaskRoleName          the ECS task role to attach the policy to (default <project>-api-task)
    githubDeployRoleName     the OIDC role cdk-deploy.yml assumes (default <project>-github-deploy)
    recordingRetentionDays   S3 expiry for call recordings (default 180)

Account and region come from the CDK CLI's environment (CDK_DEFAULT_*), i.e.
whatever AWS profile the operator runs `cdk deploy` with — the same one that
applies infra/aws/.
"""

import os

import aws_cdk as cdk

from reep_voice_platform import VoicePlatformStack

app = cdk.App()
project = app.node.try_get_context("project") or "reep"
VoicePlatformStack(
    app,
    f"{project}-voice-platform",
    project=project,
    api_task_role_name=app.node.try_get_context("apiTaskRoleName"),
    github_deploy_role_name=app.node.try_get_context("githubDeployRoleName"),
    recording_retention_days=int(app.node.try_get_context("recordingRetentionDays") or 180),
    env=cdk.Environment(
        account=os.environ.get("CDK_DEFAULT_ACCOUNT"),
        region=os.environ.get("CDK_DEFAULT_REGION"),
    ),
    description="REEP voice-assistant platform: S3, SQS, Lambda, DynamoDB, OpenSearch Serverless, IAM, SSM",
)
app.synth()
