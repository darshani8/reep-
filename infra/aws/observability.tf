# SENTRY IS THE OBSERVABILITY TOOL (errors, performance traces, both api and
# web, joined to raw logs by the request_id tag). What lives here is only what
# Sentry cannot be: the raw log plane (awslogs -> CloudWatch, where every
# rid=<X-Request-ID> access line lands), the INFRA metrics autoscaling and
# paging require, and one AI-health tripwire — silently dropped interview
# turns, which never raise an exception anywhere Sentry could see.

resource "aws_cloudwatch_log_group" "api" {
  name              = "/reep/api"
  retention_in_days = 30
}

resource "aws_sns_topic" "alerts" {
  name = "${var.project}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# --- the AI tripwire ----------------------------------------------------------
# Transcript writes are fire-and-forget by design (AGENTS.md's voice runbook):
# a perfect-sounding interview that saved NOTHING is the worst failure in this
# stack, and it is invisible to exception-based telemetry. The log line is the
# only witness — make it page.

resource "aws_cloudwatch_log_metric_filter" "dropped_turns" {
  name           = "interview-dropped-turns"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "\"Dropped interview turn\""
  metric_transformation {
    name          = "DroppedInterviewTurns"
    namespace     = "REEP/AI"
    value         = "1"
    default_value = 0
  }
}

resource "aws_cloudwatch_metric_alarm" "dropped_turns" {
  alarm_name          = "${var.project}-interview-dropped-turns"
  alarm_description   = "Interview turns are being dropped - conversations sound fine and save nothing. See the voice runbook in AGENTS.md."
  namespace           = "REEP/AI"
  metric_name         = "DroppedInterviewTurns"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# --- infra alarms -------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.project}-alb-5xx"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy" {
  alarm_name          = "${var.project}-no-healthy-api"
  alarm_description   = "Fewer than one healthy api task behind the ALB - the dashboard is down."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${var.project}-rds-low-storage"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5 * 1024 * 1024 * 1024 # 5 GB
  comparison_operator = "LessThanThreshold"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.project}-rds-cpu"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "api_cpu_pegged" {
  alarm_name          = "${var.project}-api-cpu-at-max"
  alarm_description   = "CPU high while autoscaling should have absorbed it - likely at api_max_tasks. Raise the ceiling or find the hot path in Sentry."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.api.name
  }
  alarm_actions = [aws_sns_topic.alerts.arn]
}

# --- the read-only seat for Claude --------------------------------------------
# Assume this role from an assistant session (or wire it into an AWS MCP
# server) and everything needed to DIAGNOSE is readable — logs, metrics, task
# and DB state — while nothing is writable. Fixes ship through git, not through
# a mutable console session.

resource "aws_iam_role" "claude_observer" {
  name = "${var.project}-claude-observer"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        AWS = var.observer_principal_arn != "" ? var.observer_principal_arn : "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "claude_observer_read" {
  name = "read-only-diagnosis"
  role = aws_iam_role.claude_observer.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "cloudwatch:Get*", "cloudwatch:List*", "cloudwatch:Describe*",
        "logs:Get*", "logs:Describe*", "logs:FilterLogEvents",
        "logs:StartQuery", "logs:GetQueryResults", "logs:StopQuery",
        "ecs:Describe*", "ecs:List*",
        "rds:Describe*",
        "elasticloadbalancing:Describe*",
        "application-autoscaling:Describe*",
      ]
      Resource = "*"
    }]
  })
}
