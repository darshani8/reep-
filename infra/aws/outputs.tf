output "cloudfront_domain" {
  description = "The public door. Point your DNS CNAME here when domain_name is set."
  value       = aws_cloudfront_distribution.main.domain_name
}

output "web_bucket" {
  description = "Sync apps/web/dist/web/browser here after ng build."
  value       = aws_s3_bucket.web.bucket
}

output "api_ecr_repository" {
  value = aws_ecr_repository.api.repository_url
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "db_endpoint" {
  value = aws_db_instance.main.endpoint
}

output "app_secret_arn" {
  description = "Terraform-owned: AUTH_SECRET + DATABASE_URL."
  value       = aws_secretsmanager_secret.app.arn
}

output "external_secret_arn" {
  description = "Operator-owned: put OPENAI_API_KEY / GOOGLE_* / SENTRY_DSN here."
  value       = aws_secretsmanager_secret.external.arn
}

output "claude_observer_role_arn" {
  description = "Read-only role for assistant-driven diagnosis."
  value       = aws_iam_role.claude_observer.arn
}

output "alerts_topic_arn" {
  value = aws_sns_topic.alerts.arn
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.main.id
}

output "github_deploy_role_arn" {
  description = "Role GitHub Actions assumes via OIDC to deploy. No long-lived keys."
  value       = aws_iam_role.github_deploy.arn
}

# Everything .github/workflows/deploy.yml needs, in the exact shape the setup
# step pastes. Emitted as one output so nobody has to hand-copy seven values
# and discover the typo during a deploy.
output "github_actions_setup" {
  description = "Run these once to let the Deploy workflow work (needs the gh CLI, authenticated)."
  value = join("\n", [
    "gh variable set AWS_REGION            -b '${var.region}'",
    "gh variable set AWS_DEPLOY_ROLE_ARN   -b '${aws_iam_role.github_deploy.arn}'",
    "gh variable set ECR_REPOSITORY        -b '${aws_ecr_repository.api.repository_url}'",
    "gh variable set ECS_CLUSTER           -b '${aws_ecs_cluster.main.name}'",
    "gh variable set ECS_SERVICE           -b '${aws_ecs_service.api.name}'",
    "gh variable set ECS_TASK_FAMILY       -b '${aws_ecs_task_definition.api.family}'",
    "gh variable set ECS_SUBNETS           -b '${join(",", aws_subnet.private[*].id)}'",
    "gh variable set ECS_SECURITY_GROUP    -b '${aws_security_group.api.id}'",
    "gh variable set WEB_BUCKET            -b '${aws_s3_bucket.web.bucket}'",
    "gh variable set CLOUDFRONT_ID         -b '${aws_cloudfront_distribution.main.id}'",
  ])
}

output "origin_encryption" {
  description = "Whether the CloudFront->ALB hop is encrypted."
  value = local.alb_tls ? "OK — CloudFront reaches the ALB over HTTPS." : join(" ", [
    "WARNING: no alb_acm_certificate_arn, so CloudFront reaches the ALB over PLAIN HTTP.",
    "Browsers still get TLS, and the ALB admits only CloudFront's IP ranges, but this",
    "environment must not hold real student data. Request an ACM certificate in",
    "${var.region} for a domain you control and re-apply with -var alb_acm_certificate_arn=...",
  ])
}
