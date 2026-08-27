# Security groups: each hop admits exactly the previous hop and nothing else.
# Internet -> CloudFront (WAF) -> ALB (443) -> api tasks (3300) -> RDS (5432) /
# EFS (2049). Nothing in a private subnet is reachable from the internet at all.

# CloudFront's published origin-facing ranges. Referencing the AWS-managed
# prefix list means the allow-list tracks CloudFront's own changes instead of
# rotting in this file.
data "aws_ec2_managed_prefix_list" "cloudfront" {
  count = var.restrict_alb_to_cloudfront ? 1 : 0
  name  = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name_prefix = "${var.project}-alb-"
  vpc_id      = aws_vpc.main.id

  # THE WAF IS ONLY WORTH ANYTHING IF IT CANNOT BE STEPPED AROUND. Open to
  # 0.0.0.0/0, this listener answers anyone who learns the ALB's DNS name —
  # skipping the managed rules and the per-IP rate limit that CloudFront
  # applies. Restricted to CloudFront's ranges, the edge is the only way in.
  ingress {
    description     = "HTTPS from CloudFront"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    cidr_blocks     = var.restrict_alb_to_cloudfront ? [] : ["0.0.0.0/0"]
    prefix_list_ids = var.restrict_alb_to_cloudfront ? [data.aws_ec2_managed_prefix_list.cloudfront[0].id] : []
  }
  ingress {
    description     = "HTTP - a redirect to 443, or the origin itself when no certificate is set"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    cidr_blocks     = var.restrict_alb_to_cloudfront ? [] : ["0.0.0.0/0"]
    prefix_list_ids = var.restrict_alb_to_cloudfront ? [data.aws_ec2_managed_prefix_list.cloudfront[0].id] : []
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "api" {
  name_prefix = "${var.project}-api-"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "uvicorn, from the ALB only"
    from_port       = 3300
    to_port         = 3300
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "db" {
  name_prefix = "${var.project}-db-"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres, from api tasks only"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "efs" {
  name_prefix = "${var.project}-efs-"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "NFS, from api tasks only"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.api.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  lifecycle {
    create_before_destroy = true
  }
}

# WAF in front of CloudFront: AWS managed core + known-bad-inputs rules, plus a
# per-IP rate limit far above human use and far below a scraper.
resource "aws_wafv2_web_acl" "edge" {
  provider = aws.us_east_1
  name     = "${var.project}-edge"
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-common"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-waf-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-bad-inputs"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-waf-badinputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit"
    priority = 3
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-waf-rate"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project}-waf"
    sampled_requests_enabled   = true
  }
}
