# The Real-Time AI Voice Assistant platform (apps/api-py/app/voice_platform):
# the AWS resources behind its dual-path (Undergraduate / Postgraduate) design.
#
#   S3 bulk-upload bucket  -> Lambda (validate) -> SQS ug / SQS pg  (+ DLQs)
#   S3 recording bucket    <- the api's call-close handler (dual-channel WAV/MP3)
#   DynamoDB ug / pg tables <- realtime session state
#   OpenSearch Serverless   <- session logs + question vectors
#   task-role IAM for all of the above, and the PLATFORM_* env on the api task
#
# EVERYTHING HERE IS BEHIND `var.voice_platform_enabled` (default false). The
# api boots and serves the platform's Admin CRUD without any of it: with no
# bucket the recordings stay on EFS, with no queue bulk uploads store straight
# into Postgres, with no table the session state is in-memory, with no
# collection nothing is indexed - and GET /api/platform/admin/status says so.
# Flipping the variable to true is an operator's `terraform apply`, like every
# other piece of infrastructure in this directory (deploy.yml ships code only).
#
# The engine is NOT here: it is the same Nova 2 Sonic stream the mock
# interviewer already opens, and ecs.tf's `api_bedrock` policy already grants
# it. The Aurora schema is Alembic (migration b8f2d4c6a1e0) on the existing
# database - Aurora Serverless v2 and RDS Postgres run the same SQL.

variable "voice_platform_enabled" {
  description = "Create the voice platform's S3/SQS/Lambda/DynamoDB/OpenSearch resources and wire PLATFORM_* into the api task."
  type        = bool
  default     = false
}

variable "voice_platform_recording_retention_days" {
  description = "S3 lifecycle expiry for call recordings. Mirror the per-degree recording policy's retention_days; the shorter wins."
  type        = number
  default     = 180
}

locals {
  vp_count  = var.voice_platform_enabled ? 1 : 0
  vp_prefix = "${var.project}-voice"

  # Appended to ecs.tf's api_environment when the platform is on.
  vp_environment = var.voice_platform_enabled ? [
    { name = "PLATFORM_AWS_REGION", value = var.region },
    { name = "PLATFORM_UG_QUEUE_URL", value = aws_sqs_queue.vp_candidates["UG"].url },
    { name = "PLATFORM_PG_QUEUE_URL", value = aws_sqs_queue.vp_candidates["PG"].url },
    { name = "PLATFORM_BULK_UPLOAD_BUCKET", value = aws_s3_bucket.vp_uploads[0].bucket },
    { name = "PLATFORM_RECORDINGS_BUCKET", value = aws_s3_bucket.vp_recordings[0].bucket },
    { name = "PLATFORM_DYNAMO_UG_TABLE", value = aws_dynamodb_table.vp_sessions["UG"].name },
    { name = "PLATFORM_DYNAMO_PG_TABLE", value = aws_dynamodb_table.vp_sessions["PG"].name },
    { name = "PLATFORM_OPENSEARCH_ENDPOINT", value = aws_opensearchserverless_collection.vp[0].collection_endpoint },
    { name = "PLATFORM_CLOUDWATCH_NAMESPACE", value = "REEP/VoicePlatform" },
  ] : []

  vp_degrees = var.voice_platform_enabled ? toset(["UG", "PG"]) : toset([])
}

# --- S3: bulk uploads (the Lambda trigger) and recordings ---------------------

resource "aws_s3_bucket" "vp_uploads" {
  count         = local.vp_count
  bucket_prefix = "${local.vp_prefix}-uploads-"
}

resource "aws_s3_bucket_public_access_block" "vp_uploads" {
  count                   = local.vp_count
  bucket                  = aws_s3_bucket.vp_uploads[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "vp_uploads" {
  count  = local.vp_count
  bucket = aws_s3_bucket.vp_uploads[0].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket" "vp_recordings" {
  count         = local.vp_count
  bucket_prefix = "${local.vp_prefix}-recordings-"
}

resource "aws_s3_bucket_public_access_block" "vp_recordings" {
  count                   = local.vp_count
  bucket                  = aws_s3_bucket.vp_recordings[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "vp_recordings" {
  count  = local.vp_count
  bucket = aws_s3_bucket.vp_recordings[0].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

# Student voice is deleted on a clock, like the per-speaker WAVs on EFS.
resource "aws_s3_bucket_lifecycle_configuration" "vp_recordings" {
  count  = local.vp_count
  bucket = aws_s3_bucket.vp_recordings[0].id
  rule {
    id     = "expire-recordings"
    status = "Enabled"
    filter { prefix = "recordings/" }
    expiration { days = var.voice_platform_recording_retention_days }
  }
}

# --- SQS: one stream per degree level, each with a dead-letter queue ----------

resource "aws_sqs_queue" "vp_candidates_dlq" {
  for_each                  = local.vp_degrees
  name                      = "${local.vp_prefix}-candidates-${lower(each.key)}-dlq"
  message_retention_seconds = 1209600 # 14 days: long enough for a human to read it
}

resource "aws_sqs_queue" "vp_candidates" {
  for_each                   = local.vp_degrees
  name                       = "${local.vp_prefix}-candidates-${lower(each.key)}"
  visibility_timeout_seconds = 60
  message_retention_seconds  = 345600
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.vp_candidates_dlq[each.key].arn
    maxReceiveCount     = 5
  })
}

# --- Lambda: validate the upload and push to the right stream -----------------
# The zip is the queue/ package directory as-is: stdlib + boto3 only, by design
# (see app/voice_platform/queue/__init__.py).

data "archive_file" "vp_ingest" {
  count       = local.vp_count
  type        = "zip"
  source_dir  = "${path.module}/../../apps/api-py/app/voice_platform/queue"
  output_path = "${path.module}/.terraform/vp_ingest.zip"
  excludes    = ["__pycache__", "worker.py"]
}

resource "aws_iam_role" "vp_ingest" {
  count = local.vp_count
  name  = "${local.vp_prefix}-ingest"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "vp_ingest_logs" {
  count      = local.vp_count
  role       = aws_iam_role.vp_ingest[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "vp_ingest" {
  count = local.vp_count
  name  = "ingest-candidates"
  role  = aws_iam_role.vp_ingest[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.vp_uploads[0].arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:SendMessageBatch"]
        Resource = [for q in aws_sqs_queue.vp_candidates : q.arn]
      },
    ]
  })
}

resource "aws_lambda_function" "vp_ingest" {
  count            = local.vp_count
  function_name    = "${local.vp_prefix}-candidate-ingest"
  role             = aws_iam_role.vp_ingest[0].arn
  handler          = "lambda_handler.handler"
  runtime          = "python3.12"
  timeout          = 120
  memory_size      = 512
  filename         = data.archive_file.vp_ingest[0].output_path
  source_code_hash = data.archive_file.vp_ingest[0].output_base64sha256
  environment {
    variables = {
      PLATFORM_UG_QUEUE_URL   = aws_sqs_queue.vp_candidates["UG"].url
      PLATFORM_PG_QUEUE_URL   = aws_sqs_queue.vp_candidates["PG"].url
      PLATFORM_REJECTS_PREFIX = "rejects/"
    }
  }
}

resource "aws_lambda_permission" "vp_ingest_s3" {
  count         = local.vp_count
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.vp_ingest[0].function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.vp_uploads[0].arn
}

resource "aws_s3_bucket_notification" "vp_uploads" {
  count  = local.vp_count
  bucket = aws_s3_bucket.vp_uploads[0].id
  lambda_function {
    lambda_function_arn = aws_lambda_function.vp_ingest[0].arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "uploads/"
  }
  depends_on = [aws_lambda_permission.vp_ingest_s3]
}

# --- DynamoDB: realtime session state, one table per degree level ------------

resource "aws_dynamodb_table" "vp_sessions" {
  for_each     = local.vp_degrees
  name         = "${local.vp_prefix}-sessions-${lower(each.key)}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "session_id"

  attribute {
    name = "session_id"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  server_side_encryption { enabled = true }
  point_in_time_recovery { enabled = true }
}

# --- OpenSearch Serverless: session logs + question vectors -------------------

resource "aws_opensearchserverless_security_policy" "vp_encryption" {
  count = local.vp_count
  name  = "${local.vp_prefix}-enc"
  type  = "encryption"
  policy = jsonencode({
    Rules = [{
      ResourceType = "collection"
      Resource     = ["collection/${local.vp_prefix}"]
    }]
    AWSOwnedKey = true
  })
}

resource "aws_opensearchserverless_security_policy" "vp_network" {
  count = local.vp_count
  name  = "${local.vp_prefix}-net"
  type  = "network"
  policy = jsonencode([{
    Rules = [
      { ResourceType = "collection", Resource = ["collection/${local.vp_prefix}"] },
      { ResourceType = "dashboard", Resource = ["collection/${local.vp_prefix}"] },
    ]
    # Reached from inside the VPC by the api tasks. Public access is the
    # simplest working default for the Serverless endpoint; a VPC endpoint
    # (aws_opensearchserverless_vpc_endpoint) tightens it later without a
    # code change.
    AllowFromPublic = true
  }])
}

resource "aws_opensearchserverless_collection" "vp" {
  count      = local.vp_count
  name       = local.vp_prefix
  type       = "VECTORSEARCH"
  depends_on = [aws_opensearchserverless_security_policy.vp_encryption, aws_opensearchserverless_security_policy.vp_network]
}

resource "aws_opensearchserverless_access_policy" "vp" {
  count = local.vp_count
  name  = "${local.vp_prefix}-access"
  type  = "data"
  policy = jsonencode([{
    Rules = [
      {
        ResourceType = "index"
        Resource     = ["index/${local.vp_prefix}/*"]
        Permission   = ["aoss:CreateIndex", "aoss:DescribeIndex", "aoss:UpdateIndex", "aoss:ReadDocument", "aoss:WriteDocument"]
      },
      {
        ResourceType = "collection"
        Resource     = ["collection/${local.vp_prefix}"]
        Permission   = ["aoss:DescribeCollectionItems"]
      },
    ]
    Principal = [aws_iam_role.api_task.arn]
  }])
}

# --- The api task's permissions -----------------------------------------------

resource "aws_iam_role_policy" "vp_api" {
  count = local.vp_count
  name  = "voice-platform"
  role  = aws_iam_role.api_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
        Resource = ["${aws_s3_bucket.vp_recordings[0].arn}/*", "${aws_s3_bucket.vp_uploads[0].arn}/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:SendMessageBatch", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = [for q in aws_sqs_queue.vp_candidates : q.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem", "dynamodb:Query"]
        Resource = [for t in aws_dynamodb_table.vp_sessions : t.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["aoss:APIAccessAll"]
        Resource = aws_opensearchserverless_collection.vp[0].arn
      },
      {
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = "REEP/VoicePlatform" } }
      },
    ]
  })
}

output "voice_platform" {
  value = var.voice_platform_enabled ? {
    uploads_bucket    = aws_s3_bucket.vp_uploads[0].bucket
    recordings_bucket = aws_s3_bucket.vp_recordings[0].bucket
    ug_queue          = aws_sqs_queue.vp_candidates["UG"].url
    pg_queue          = aws_sqs_queue.vp_candidates["PG"].url
    opensearch        = aws_opensearchserverless_collection.vp[0].collection_endpoint
  } : null
  description = "The voice platform's endpoints, or null when var.voice_platform_enabled is false."
}
