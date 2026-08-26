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
