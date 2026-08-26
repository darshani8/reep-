# EFS carries everything the api writes to disk: student uploads, staff
# certificates, alumni resumes (UPLOAD_DIR=/data/uploads) and — the call
# recorder — the per-speaker interview WAVs app/interview_audio.py stores at
# the uploads path's SIBLING, /data/interview-audio. On EFS these all survive
# task restarts and deploys, which is precisely what the UPLOAD_DIR setting's
# history in app/config.py demands. Encrypted at rest; AWS Backup covers it in
# database.tf's plan.

resource "aws_efs_file_system" "data" {
  creation_token = "${var.project}-data"
  encrypted      = true

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }

  tags = { Name = "${var.project}-data" }
}

resource "aws_efs_mount_target" "data" {
  count           = 2
  file_system_id  = aws_efs_file_system.data.id
  subnet_id       = aws_subnet.private[count.index].id
  security_groups = [aws_security_group.efs.id]
}

# The api container runs as its image's user; the access point pins ownership
# so every task sees the same uid/gid regardless of image changes.
resource "aws_efs_access_point" "data" {
  file_system_id = aws_efs_file_system.data.id
  posix_user {
    uid = 1000
    gid = 1000
  }
  root_directory {
    path = "/reep-data"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "750"
    }
  }
}

# --- the SPA ------------------------------------------------------------------
# Private bucket; CloudFront reads it through an Origin Access Control. Nothing
# serves from S3 directly.

resource "aws_s3_bucket" "web" {
  bucket_prefix = "${var.project}-web-"
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "web" {
  bucket = aws_s3_bucket.web.id
  versioning_configuration {
    status = "Enabled"
  }
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.web.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.main.arn
        }
      }
    }]
  })
}

# --- ALB access logs ----------------------------------------------------------
# The edge half of traceability: every request the ALB forwards is a log line
# here, joinable to the api's rid=<X-Request-ID> access line and to Sentry's
# request_id tag.

data "aws_elb_service_account" "main" {}

resource "aws_s3_bucket" "alb_logs" {
  bucket_prefix = "${var.project}-alb-logs-"
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  bucket                  = aws_s3_bucket.alb_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    id     = "expire-90d"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = data.aws_elb_service_account.main.arn }
      Action    = "s3:PutObject"
      Resource  = "${aws_s3_bucket.alb_logs.arn}/*"
    }]
  })
}
