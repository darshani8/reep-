# infra/cdk — the voice-assistant platform's AWS resources (AWS CDK, Python)

One stack, `reep-voice-platform`, for everything the platform
(`apps/api-py/app/voice_platform/`) projects into AWS:

| Piece | Resource |
|---|---|
| Bulk candidate uploads (`uploads/`) | S3 bucket → Lambda `reep-voice-candidate-ingest` |
| Candidate streams | SQS `reep-voice-candidates-ug` / `-pg`, each with a DLQ |
| Call recordings (dual-channel WAV/MP3) | S3 bucket, expiring on `recordingRetentionDays` |
| Realtime session state | DynamoDB `reep-voice-sessions-ug` / `-pg` (TTL `expires_at`) |
| Session logs + question vectors | OpenSearch Serverless `reep-voice` (VECTORSEARCH) |
| What the api may do | an IAM policy attached to the **existing** task role `reep-api-task` |
| The api's environment | SSM parameters `/reep/voice-platform/PLATFORM_*` |

The rest of REEP (VPC, ALB, ECS, RDS, the task role itself) is the Terraform
stack in `infra/aws/` and stays there: this stack is additive, imports the
task role by name, and hands its outputs to Terraform through SSM.

## Deploy

```
cd infra/cdk
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
npm install -g aws-cdk          # the CLI; the library is in the venv
.venv/bin/python -m pytest      # synth + template assertions, no AWS needed
cdk bootstrap                   # once per account/region
cdk deploy                      # creates the resources and the SSM parameters
```

Then in `infra/aws/`, set `voice_platform_enabled = true` and `terraform
apply`: `voice_platform_bridge.tf` reads the SSM parameters into the api task
definition's environment, and the next `deploy.yml` run picks them up.
`GET /api/platform/admin/status` shows each piece switch from off to on.

Context values (`cdk.json`, or `-c key=value`): `project` (default `reep`),
`apiTaskRoleName` (default `<project>-api-task`), `recordingRetentionDays`
(default 180 — mirror the per-degree recording policy's `retention_days`).

## Why CDK here and Terraform there

The core stack was built in Terraform and is live; rewriting it would be a
migration of running infrastructure for no functional gain. The platform is
new, self-contained and additive, so it is written in CDK as asked, with the
SSM parameters as the one-directional seam between the two.
