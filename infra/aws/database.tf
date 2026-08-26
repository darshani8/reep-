# RDS PostgreSQL 17 — the same major the compose file runs, pgvector included
# (run `CREATE EXTENSION vector;` once as the master user before the first
# alembic upgrade; the runbook has the exact command).
#
# Backups, twice: RDS automated snapshots (point-in-time restore inside the
# retention window) AND an AWS Backup plan (a second, independent vault, so a
# fat-fingered `terraform destroy` of the instance cannot take its history
# with it). deletion_protection + final snapshot close the remaining doors.

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.project}-db"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_instance" "main" {
  identifier     = "${var.project}-postgres"
  engine         = "postgres"
  engine_version = "17"

  instance_class        = var.db_instance_class
  allocated_storage     = 20
  max_allocated_storage = 100 # storage autoscaling: grows itself before it fills
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "reep_py"
  username = "reep"
  password = random_password.db.result

  multi_az               = var.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false

  backup_retention_period   = var.db_backup_retention_days
  backup_window             = "20:30-21:30" # 02:00-03:00 IST, off-hours for the cohort
  maintenance_window        = "sun:21:30-sun:22:30"
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.project}-postgres-final"
  copy_tags_to_snapshot     = true

  performance_insights_enabled    = true
  enabled_cloudwatch_logs_exports = ["postgresql"]
  auto_minor_version_upgrade      = true

  apply_immediately = false
}

# The second, independent backup plane.
resource "aws_backup_vault" "main" {
  name = "${var.project}-vault"
}

resource "aws_backup_plan" "daily" {
  name = "${var.project}-daily"
  rule {
    rule_name         = "daily-35d"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(30 21 * * ? *)" # 03:00 IST
    lifecycle {
      delete_after = 35
    }
  }
}

resource "aws_iam_role" "backup" {
  name = "${var.project}-backup"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "backup.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_selection" "db_and_efs" {
  name         = "${var.project}-db-efs"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.daily.id
  resources = [
    aws_db_instance.main.arn,
    aws_efs_file_system.data.arn,
  ]
}
