resource "aws_ecs_cluster" "main" {
  name = var.project
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# --- IAM: execution (pull, log, read secrets) vs task (what the CODE may do) --

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.project}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name = "read-app-secrets"
  role = aws_iam_role.task_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_secretsmanager_secret.app.arn, aws_secretsmanager_secret.external.arn]
    }]
  })
}

resource "aws_iam_role" "api_task" {
  name               = "${var.project}-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# The ONLY AWS API the application code holds: invoking Nova on Bedrock. No S3,
# no Secrets Manager (secrets arrive as env at launch), nothing else — a
# compromised task can talk to a model and that is all.
#
# THE THIRD ACTION IS A SEPARATE PERMISSION, not a variant of the other two.
# InvokeModelWithBidirectionalStream is what app/interview_nova.py opens for the
# speech-to-speech interviewer, and a role holding the first two is refused it —
# which reaches the student as an AccessDeniedException at the handshake, i.e.
# close 4002 and an interview that will not start, with the cause visible only
# in the API log. Granted unconditionally rather than behind
# var.interview_engine: the permission is inert until something opens that
# stream, and a role whose contents depend on an application setting is a role
# nobody can reason about from the console.
resource "aws_iam_role_policy" "api_bedrock" {
  name = "invoke-nova"
  role = aws_iam_role.api_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:InvokeModelWithBidirectionalStream",
      ]
      Resource = [
        "arn:aws:bedrock:*::foundation-model/amazon.nova-*",
        "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*",
      ]
    }]
  })
}

# --- the api task -------------------------------------------------------------

locals {
  web_origin = var.domain_name != "" ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.main.domain_name}"
  api_image  = "${aws_ecr_repository.api.repository_url}:latest"

  api_environment = [
    { name = "ENV", value = "prod" },
    { name = "WEB_ORIGIN", value = local.web_origin },
    # Everything the api writes to disk lives on EFS: uploads here, and the
    # interview call recordings at this path's sibling /data/interview-audio.
    { name = "UPLOAD_DIR", value = "/data/uploads" },
    { name = "INTERVIEW_RECORDING_ENABLED", value = var.interview_recording_enabled },
    { name = "BEDROCK_MODEL", value = var.bedrock_model },
    { name = "BEDROCK_REGION", value = var.region },
    # Which engine runs the mock interview, and where its model lives. The
    # region is passed even while the engine is "openai", so that turning the
    # interviewer on is one variable rather than two — and so that it can never
    # be inherited from BEDROCK_REGION, which points at a region that does not
    # serve Nova 2 Sonic (see the variable's own note).
    { name = "INTERVIEW_ENGINE", value = var.interview_engine },
    { name = "NOVA_SONIC_REGION", value = var.nova_sonic_region },
    { name = "LLM_ALLOW_REMOTE_STUDENT_DATA", value = var.allow_remote_student_data },
  ]

  api_secrets = [
    { name = "AUTH_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:AUTH_SECRET::" },
    { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.app.arn}:DATABASE_URL::" },
    { name = "OPENAI_API_KEY", valueFrom = "${aws_secretsmanager_secret.external.arn}:OPENAI_API_KEY::" },
    { name = "GOOGLE_CLIENT_ID", valueFrom = "${aws_secretsmanager_secret.external.arn}:GOOGLE_CLIENT_ID::" },
    { name = "GOOGLE_CLIENT_SECRET", valueFrom = "${aws_secretsmanager_secret.external.arn}:GOOGLE_CLIENT_SECRET::" },
    { name = "SENTRY_DSN", valueFrom = "${aws_secretsmanager_secret.external.arn}:SENTRY_DSN::" },
    { name = "VOICE_WORKER_SECRET", valueFrom = "${aws_secretsmanager_secret.external.arn}:VOICE_WORKER_SECRET::" },
  ]
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.project}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  volume {
    name = "data"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.data.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.data.id
        iam             = "DISABLED"
      }
    }
  }

  container_definitions = jsonencode([{
    name         = "api"
    image        = local.api_image
    essential    = true
    portMappings = [{ containerPort = 3300, protocol = "tcp" }]
    environment  = local.api_environment
    secrets      = local.api_secrets
    mountPoints  = [{ sourceVolume = "data", containerPath = "/data" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "api"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_min_tasks
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3300
  }

  health_check_grace_period_seconds = 60

  # A bad image rolls itself back instead of flapping the whole service down.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [desired_count] # autoscaling owns it after creation
  }

  depends_on = [aws_lb_listener.https, aws_lb_listener.http_origin]
}

# --- autoscaling --------------------------------------------------------------

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_min_tasks
  max_capacity       = var.api_max_tasks
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "cpu-target"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_policy" "api_memory" {
  name               = "memory-target"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
    target_value       = 75
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

# --- the daily retention run --------------------------------------------------
# The compose file's while-loop sidecar becomes a scheduled Fargate task: same
# image, command `python -m app.retention_job`, once a day at 03:00 IST. A
# failed run logs, alarms (observability.tf) and is retried tomorrow.

resource "aws_iam_role" "scheduler" {
  name = "${var.project}-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "scheduler_run_task" {
  name = "run-retention-task"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = ["${aws_ecs_task_definition.api.arn_without_revision}:*"]
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.task_execution.arn, aws_iam_role.api_task.arn]
      }
    ]
  })
}

resource "aws_scheduler_schedule" "retention" {
  name                = "${var.project}-retention-daily"
  schedule_expression = "cron(30 21 * * ? *)" # 03:00 IST

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.api.arn
      launch_type         = "FARGATE"
      network_configuration {
        subnets          = aws_subnet.private[*].id
        security_groups  = [aws_security_group.api.id]
        assign_public_ip = false
      }
    }

    input = jsonencode({
      containerOverrides = [{
        name    = "api"
        command = ["python", "-m", "app.retention_job"]
      }]
    })
  }
}
