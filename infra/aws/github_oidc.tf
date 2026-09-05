# Deploying from the browser: GitHub Actions assumes a role here via OIDC.
#
# NO LONG-LIVED KEYS. GitHub presents a short-lived OIDC token, AWS trades it
# for temporary credentials, and the trust policy pins WHICH repository and ref
# may do that — so a fork, a pull request from a stranger, or a leaked secret
# in another repo cannot deploy this account. An access key pasted into GitHub
# secrets would be a permanent credential sitting in a system this project does
# not control; this is the alternative that does not age.
#
# The role's policy is deliberately narrow: push to THIS ECR repository, roll
# THIS ECS service, run a task with THIS task family, write THIS web bucket and
# invalidate THIS distribution. It cannot read the database, read a secret, or
# create infrastructure — `terraform apply` stays a human action at a terminal,
# where the plan can be read before it runs.

variable "github_repository" {
  description = "owner/repo allowed to deploy (the OIDC subject is pinned to it)."
  type        = string
  default     = "darshani8/reep-"
}

variable "github_repository_ids" {
  description = "owner@OWNER_ID/repo@REPO_ID, the id-carrying spelling of github_repository that current GitHub OIDC tokens put in their sub claim. Read the exact value from a CloudTrail AssumeRoleWithWebIdentity event. Empty = only the plain spelling is trusted."
  type        = string
  default     = "darshani8@285224354/reep-@1339637272"
}

variable "github_deploy_ref" {
  description = "Git ref allowed to deploy. Keep it to main; widen only deliberately."
  type        = string
  default     = "refs/heads/main"
}

# One OIDC provider per account. Set to false if the account already has the
# GitHub provider registered by another stack — two of them is an error.
variable "create_github_oidc_provider" {
  type    = bool
  default = true
}

resource "aws_iam_openid_connect_provider" "github" {
  count           = var.create_github_oidc_provider ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

locals {
  github_oidc_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
}

resource "aws_iam_role" "github_deploy" {
  name = "${var.project}-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.github_oidc_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          # The whole security of this door: only this repo, only this ref.
          #
          # TWO subject spellings, because GitHub changed the claim under us:
          # tokens now carry owner and repository IDS in the sub
          # (repo:owner@OWNER_ID/name@REPO_ID:ref:...), and the first real
          # deploy died on AccessDenied that only CloudTrail could explain --
          # the workflow log just says "Not authorized". The ID-carrying form
          # is the stronger pin (a deleted-and-recreated repository gets new
          # ids and stops matching), so it leads; the plain form stays so a
          # rollback of GitHub's format cannot brick deploys.
          "token.actions.githubusercontent.com:sub" = compact([
            var.github_repository_ids != "" ? "repo:${var.github_repository_ids}:ref:${var.github_deploy_ref}" : "",
            "repo:${var.github_repository}:ref:${var.github_deploy_ref}",
          ])
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_deploy" {
  name = "deploy-api-and-spa"
  role = aws_iam_role.github_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrLogin"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "PushTheApiImage"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
          "ecr:BatchGetImage", "ecr:DescribeImages",
        ]
        Resource = aws_ecr_repository.api.arn
      },
      {
        Sid      = "RollTheService"
        Effect   = "Allow"
        Action   = ["ecs:UpdateService", "ecs:DescribeServices"]
        Resource = aws_ecs_service.api.id
      },
      {
        Sid      = "RunOneOffTasks"
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = "${aws_ecs_task_definition.api.arn_without_revision}:*"
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn }
        }
      },
      {
        Sid      = "WatchThoseTasks"
        Effect   = "Allow"
        Action   = ["ecs:DescribeTasks", "ecs:DescribeTaskDefinition"]
        Resource = "*"
      },
      {
        Sid      = "HandTheTaskItsRoles"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.task_execution.arn, aws_iam_role.api_task.arn]
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      },
      {
        Sid      = "PublishTheSpa"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.web.arn
      },
      {
        Sid      = "WriteTheSpa"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject", "s3:GetObject"]
        Resource = "${aws_s3_bucket.web.arn}/*"
      },
      {
        Sid      = "BustTheCache"
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
        Resource = aws_cloudfront_distribution.main.arn
      },
    ]
  })
}

# --- Deploying the voice platform's CDK stack from GitHub Actions ----------------
#
# infra/cdk is deployed by .github/workflows/cdk-deploy.yml through the SAME
# reep-github-deploy role, pinned to this repository and to main. The CDK CLI
# does not need this role to hold the resource permissions itself: it assumes
# the account's CDK bootstrap roles (cdk-hnb659fds-deploy-role, -file-publishing-
# role, -lookup-role — created once by `cdk bootstrap`, run by a human with admin
# credentials) and CloudFormation does the work under the bootstrap's cfn-exec
# role. So the grant here is only "may assume those roles" plus reading the
# bootstrap version parameter the CLI checks first. Nothing here is gated on
# voice_platform_enabled: the stack must exist before the bridge can read its
# parameters, so this door opens first.
resource "aws_iam_role_policy" "github_deploy_cdk" {
  name = "deploy-cdk-stacks"
  role = aws_iam_role.github_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "AssumeTheCdkBootstrapRoles"
        Effect   = "Allow"
        Action   = ["sts:AssumeRole"]
        Resource = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/cdk-hnb659fds-*"
      },
      {
        Sid      = "ReadTheBootstrapVersion"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = "arn:aws:ssm:*:${data.aws_caller_identity.current.account_id}:parameter/cdk-bootstrap/*"
      },
    ]
  })
}
