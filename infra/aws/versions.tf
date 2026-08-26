# REEP on AWS — ECS Fargate + RDS Postgres + EFS + CloudFront, with autoscaling,
# backups, security and Sentry-first observability. Read docs/aws-deployment.md
# before the first apply; it is the runbook this stack is applied FROM.

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "reep"
      ManagedBy = "terraform"
    }
  }
}

# CloudFront's certificate and WAF Web ACL must live in us-east-1 regardless of
# where the stack runs — a hard CloudFront rule, not a choice.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = {
      Project   = "reep"
      ManagedBy = "terraform"
    }
  }
}
