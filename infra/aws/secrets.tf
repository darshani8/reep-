# Two secrets, two owners.
#
# `app` is TERRAFORM-OWNED: AUTH_SECRET and DATABASE_URL are generated here, so
# no human ever types (or leaks) them, and the boot guard's "repo default in
# prod" refusal can never fire against them.
#
# `external` is OPERATOR-OWNED: keys for services only a human can obtain
# (OpenAI, Google OAuth, Sentry DSN, the voice-worker shared secret). Terraform
# creates the shell with blank values and then NEVER overwrites it
# (ignore_changes), so `aws secretsmanager put-secret-value` edits stick across
# applies. Blank values degrade exactly as the app documents: no OpenAI key =
# interviewer unavailable (everything else fine); no Google keys = the login
# button renders disabled with the reason; no Sentry DSN = telemetry off.

resource "random_password" "auth_secret" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  name_prefix = "${var.project}/app-"
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    AUTH_SECRET = random_password.auth_secret.result
    DATABASE_URL = format(
      "postgresql+psycopg://%s:%s@%s/%s",
      aws_db_instance.main.username,
      random_password.db.result,
      aws_db_instance.main.endpoint,
      aws_db_instance.main.db_name,
    )
  })
}

resource "aws_secretsmanager_secret" "external" {
  name_prefix = "${var.project}/external-"
}

resource "aws_secretsmanager_secret_version" "external" {
  secret_id = aws_secretsmanager_secret.external.id
  secret_string = jsonencode({
    OPENAI_API_KEY       = ""
    GOOGLE_CLIENT_ID     = ""
    GOOGLE_CLIENT_SECRET = ""
    SENTRY_DSN           = ""
    VOICE_WORKER_SECRET  = ""
  })
  lifecycle {
    ignore_changes = [secret_string]
  }
}
