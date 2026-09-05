# The bridge to the voice platform's CDK stack (infra/cdk).
#
# The platform's AWS resources — S3, SQS, Lambda, DynamoDB, OpenSearch
# Serverless and the api task role's extra policy — are created by AWS CDK, not
# by this Terraform stack. What Terraform still owns is the api TASK DEFINITION,
# and the api reads its PLATFORM_* settings from the environment, so the two
# stacks meet at SSM Parameter Store: `cdk deploy` writes
# /<project>/voice-platform/PLATFORM_*, and with `voice_platform_enabled = true`
# this file reads them into ecs.tf's api_environment_all. One direction, no
# cycle, and no resource is defined twice.
#
# With the variable false (the default) nothing is read and nothing is added:
# the api boots without the platform's projections and says so at
# GET /api/platform/admin/status.

variable "voice_platform_enabled" {
  description = "Read the CDK stack's /<project>/voice-platform/* SSM parameters into the api task environment. Deploy infra/cdk first."
  type        = bool
  default     = false
}

locals {
  vp_parameter_names = var.voice_platform_enabled ? toset([
    "PLATFORM_AWS_REGION",
    "PLATFORM_UG_QUEUE_URL",
    "PLATFORM_PG_QUEUE_URL",
    "PLATFORM_BULK_UPLOAD_BUCKET",
    "PLATFORM_RECORDINGS_BUCKET",
    "PLATFORM_DYNAMO_UG_TABLE",
    "PLATFORM_DYNAMO_PG_TABLE",
    "PLATFORM_OPENSEARCH_ENDPOINT",
    "PLATFORM_CLOUDWATCH_NAMESPACE",
  ]) : toset([])
}

data "aws_ssm_parameter" "voice_platform" {
  for_each = local.vp_parameter_names
  name     = "/${var.project}/voice-platform/${each.key}"
}

locals {
  vp_environment = [
    for name in sort(tolist(local.vp_parameter_names)) : {
      name  = name
      value = data.aws_ssm_parameter.voice_platform[name].value
    }
  ]
}
