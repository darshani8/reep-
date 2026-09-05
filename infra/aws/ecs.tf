resource "aws_ecs_cluster" "main" {
 voice_platform.tf is switched on (an empty list otherwise).name = var.project
 voice_platform.tf is switched on (an empty list otherwise).setting {
 voice_platform.tf is switched on (an empty list otherwise).  name  = "containerInsights"
 voice_platform.tf is switched on (an empty list otherwise).  value = "enabled"
 voice_platform.tf is switched on (an empty list otherwise).}
}

# --- IAM: execution (pull, log, read secrets) vs task (what the CODE may do) --

data "aws_iam_policy_document" "ecs_assume" {
 voice_platform.tf is switched on (an empty list otherwise).statement {
 voice_platform.tf is switched on (an empty list otherwise).  actions = ["sts:AssumeRole"]
 voice_platform.tf is switched on (an empty list otherwise).  principals {
 voice_platform.tf is switched on (an empty list otherwise).    type        = "Service"
 voice_platform.tf is switched on (an empty list otherwise).    identifiers = ["ecs-tasks.amazonaws.com"]
 voice_platform.tf is switched on (an empty list otherwise).  }
 voice_platform.tf is switched on (an empty list otherwise).}
}

resource "aws_iam_role" "task_execution" {
 voice_platform.tf is switched on (an empty list otherwise).name               = "${var.project}-task-execution"
 voice_platform.tf is switched on (an empty list otherwise).assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
 voice_platform.tf is switched on (an empty list otherwise).role       = aws_iam_role.task_execution.name
 voice_platform.tf is switched on (an empty list otherwise).policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "task_execution_secrets" {
 voice_platform.tf is switched on (an empty list otherwise).name = "read-app-secrets"
 voice_platform.tf is switched on (an empty list otherwise).role = aws_iam_role.task_execution.id
 voice_platform.tf is switched on (an empty list otherwise).policy = jsonencode({
 voice_platform.tf is switched on (an empty list otherwise).  Version = "2012-10-17"
 voice_platform.tf is switched on (an empty list otherwise).  Statement = [{
 voice_platform.tf is switched on (an empty list otherwise).    Effect   = "Allow"
 voice_platform.tf is switched on (an empty list otherwise).    Action   = ["secretsmanager:GetSecretValue"]
 voice_platform.tf is switched on (an empty list otherwise).    Resource = [aws_secretsmanager_secret.app.arn, aws_secretsmanager_secret.external.arn]
 voice_platform.tf is switched on (an empty list otherwise).  }]
 voice_platform.tf is switched on (an empty list otherwise).})
}

resource "aws_iam_role" "api_task" {
 voice_platform.tf is switched on (an empty list otherwise).name               = "${var.project}-api-task"
 voice_platform.tf is switched on (an empty list otherwise).assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
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
 voice_platform.tf is switched on (an empty list otherwise).name = "invoke-nova"
 voice_platform.tf is switched on (an empty list otherwise).role = aws_iam_role.api_task.id
 voice_platform.tf is switched on (an empty list otherwise).policy = jsonencode({
 voice_platform.tf is switched on (an empty list otherwise).  Version = "2012-10-17"
 voice_platform.tf is switched on (an empty list otherwise).  Statement = [{
 voice_platform.tf is switched on (an empty list otherwise).    Effect = "Allow"
 voice_platform.tf is switched on (an empty list otherwise).    Action = [
 voice_platform.tf is switched on (an empty list otherwise).      "bedrock:InvokeModel",
 voice_platform.tf is switched on (an empty list otherwise).      "bedrock:InvokeModelWithResponseStream",
 voice_platform.tf is switched on (an empty list otherwise).      "bedrock:InvokeModelWithBidirectionalStream",
 voice_platform.tf is switched on (an empty list otherwise).    ]
 voice_platform.tf is switched on (an empty list otherwise).    Resource = [
 voice_platform.tf is switched on (an empty list otherwise).      "arn:aws:bedrock:*::foundation-model/amazon.nova-*",
 voice_platform.tf is switched on (an empty list otherwise).      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*",
 voice_platform.tf is switched on (an empty list otherwise).    ]
 voice_platform.tf is switched on (an empty list otherwise).  }]
 voice_platform.tf is switched on (an empty list otherwise).})
}

# --- the api task -------------------------------------------------------------

locals {
 voice_platform.tf is switched on (an empty list otherwise).web_origin = var.domain_name != "" ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.main.domain_name}"
 voice_platform.tf is switched on (an empty list otherwise).api_image  = "${aws_ecr_repository.api.repository_url}:latest"

 voice_platform.tf is switched on (an empty list otherwise).api_environment = [
 voice_platform.tf is switched on (an empty list otherwise).  { name = "ENV", value = "prod" },
 voice_platform.tf is switched on (an empty list otherwise).  { name = "WEB_ORIGIN", value = local.web_origin },
 voice_platform.tf is switched on (an empty list otherwise).  # Everything the api writes to disk lives on EFS: uploads here, and the
 voice_platform.tf is switched on (an empty list otherwise).  # interview call recordings at this path's sibling /data/interview-audio.
 voice_platform.tf is switched on (an empty list otherwise).  { name = "UPLOAD_DIR", value = "/data/uploads" },
 voice_platform.tf is switched on (an empty list otherwise).  { name = "INTERVIEW_RECORDING_ENABLED", value = var.interview_recording_enabled },
 voice_platform.tf is switched on (an empty list otherwise).  { name = "BEDROCK_MODEL", value = var.bedrock_model },
 voice_platform.tf is switched on (an empty list otherwise).  { name = "BEDROCK_REGION", value = var.region },
 voice_platform.tf is switched on (an empty list otherwise).  # Which engine runs the mock interview, and where its model lives. The
 voice_platform.tf is switched on (an empty list otherwise).  # region is passed even while the engine is "openai", so that turning the
 voice_platform.tf is switched on (an empty list otherwise).  # interviewer on is one variable rather than two — and so that it can never
 voice_platform.tf is switched on (an empty list otherwise).  # be inherited from BEDROCK_REGION, which points at a region that does not
 voice_platform.tf is switched on (an empty list otherwise).  # serve Nova 2 Sonic (see the variable's own note).
 voice_platform.tf is switched on (an empty list otherwise).  { name = "INTERVIEW_CONSENT_VERSION", value = var.interview_consent_version },

 voice_platform.tf is switched on (an empty list otherwise).  { name = "INTERVIEW_ENGINE", value = var.interview_engine },
 voice_platform.tf is switched on (an empty list otherwise).  { name = "NOVA_SONIC_REGION", value = var.nova_sonic_region },
 voice_platform.tf is switched on (an empty list otherwise).  { name = "LLM_ALLOW_REMOTE_STUDENT_DATA", value = var.allow_remote_student_data },
 voice_platform.tf is switched on (an empty list otherwise).]

 voice_platform.tf is switched on (an empty list otherwise).# api_environment plus the voice platform's PLATFORM_* variables when
 voice_platform.tf is switched on (an empty list otherwise).# voice_platform.tf is switched on (an empty list otherwise).
 voice_platform.tf is switched on (an empty list otherwise).api_environment_all = concat(local.api_environment, local.vp_environment)

 voice_platform.tf is switched on (an empty list otherwise).api_secrets = [
 voice_platform.tf is switched on (an empty list otherwise).  { name = "AUTH_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:AUTH_SECRET::" },
 voice_platform.tf is switched on (an empty list otherwise).  { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.app.arn}:DATABASE_URL::" },
 voice_platform.tf is switched on (an empty list otherwise).  { name = "GOOGLE_CLIENT_ID", valueFrom = "${aws_secretsmanager_secret.external.arn}:GOOGLE_CLIENT_ID::" },
 voice_platform.tf is switched on (an empty list otherwise).  { name = "GOOGLE_CLIENT_SECRET", valueFrom = "${aws_secretsmanager_secret.external.arn}:GOOGLE_CLIENT_SECRET::" },
 voice_platform.tf is switched on (an empty list otherwise).  { name = "SENTRY_DSN", valueFrom = "${aws_secretsmanager_secret.external.arn}:SENTRY_DSN::" },
 voice_platform.tf is switched on (an empty list otherwise).  { name = "VOICE_WORKER_SECRET", valueFrom = "${aws_secretsmanager_secret.external.arn}:VOICE_WORKER_SECRET::" },
 voice_platform.tf is switched on (an empty list otherwise).]
}

resource "aws_ecs_task_definition" "api" {
 voice_platform.tf is switched on (an empty list otherwise).family                   = "${var.project}-api"
 voice_platform.tf is switched on (an empty list otherwise).requires_compatibilities = ["FARGATE"]
 voice_platform.tf is switched on (an empty list otherwise).network_mode             = "awsvpc"
 voice_platform.tf is switched on (an empty list otherwise).cpu                      = var.api_cpu
 voice_platform.tf is switched on (an empty list otherwise).memory                   = var.api_memory
 voice_platform.tf is switched on (an empty list otherwise).execution_role_arn       = aws_iam_role.task_execution.arn
 voice_platform.tf is switched on (an empty list otherwise).task_role_arn            = aws_iam_role.api_task.arn

 voice_platform.tf is switched on (an empty list otherwise).volume {
 voice_platform.tf is switched on (an empty list otherwise).  name = "data"
 voice_platform.tf is switched on (an empty list otherwise).  efs_volume_configuration {
 voice_platform.tf is switched on (an empty list otherwise).    file_system_id     = aws_efs_file_system.data.id
 voice_platform.tf is switched on (an empty list otherwise).    transit_encryption = "ENABLED"
 voice_platform.tf is switched on (an empty list otherwise).    authorization_config {
 voice_platform.tf is switched on (an empty list otherwise).      access_point_id = aws_efs_access_point.data.id
 voice_platform.tf is switched on (an empty list otherwise).      iam             = "DISABLED"
 voice_platform.tf is switched on (an empty list otherwise).    }
 voice_platform.tf is switched on (an empty list otherwise).  }
 voice_platform.tf is switched on (an empty list otherwise).}

 voice_platform.tf is switched on (an empty list otherwise).container_definitions = jsonencode([{
 voice_platform.tf is switched on (an empty list otherwise).  name         = "api"
 voice_platform.tf is switched on (an empty list otherwise).  image        = local.api_image
 voice_platform.tf is switched on (an empty list otherwise).  essential    = true
 voice_platform.tf is switched on (an empty list otherwise).  portMappings = [{ containerPort = 3300, protocol = "tcp" }]
 voice_platform.tf is switched on (an empty list otherwise).  environment  = local.api_environment_all
 voice_platform.tf is switched on (an empty list otherwise).  secrets      = local.api_secrets
 voice_platform.tf is switched on (an empty list otherwise).  mountPoints  = [{ sourceVolume = "data", containerPath = "/data" }]
 voice_platform.tf is switched on (an empty list otherwise).  logConfiguration = {
 voice_platform.tf is switched on (an empty list otherwise).    logDriver = "awslogs"
 voice_platform.tf is switched on (an empty list otherwise).    options = {
 voice_platform.tf is switched on (an empty list otherwise).      awslogs-group         = aws_cloudwatch_log_group.api.name
 voice_platform.tf is switched on (an empty list otherwise).      awslogs-region        = var.region
 voice_platform.tf is switched on (an empty list otherwise).      awslogs-stream-prefix = "api"
 voice_platform.tf is switched on (an empty list otherwise).    }
 voice_platform.tf is switched on (an empty list otherwise).  }
 voice_platform.tf is switched on (an empty list otherwise).}])
}

resource "aws_ecs_service" "api" {
 voice_platform.tf is switched on (an empty list otherwise).name            = "api"
 voice_platform.tf is switched on (an empty list otherwise).cluster         = aws_ecs_cluster.main.id
 voice_platform.tf is switched on (an empty list otherwise).task_definition = aws_ecs_task_definition.api.arn
 voice_platform.tf is switched on (an empty list otherwise).desired_count   = var.api_min_tasks
 voice_platform.tf is switched on (an empty list otherwise).launch_type     = "FARGATE"

 voice_platform.tf is switched on (an empty list otherwise).network_configuration {
 voice_platform.tf is switched on (an empty list otherwise).  subnets          = aws_subnet.private[*].id
 voice_platform.tf is switched on (an empty list otherwise).  security_groups  = [aws_security_group.api.id]
 voice_platform.tf is switched on (an empty list otherwise).  assign_public_ip = false
 voice_platform.tf is switched on (an empty list otherwise).}

 voice_platform.tf is switched on (an empty list otherwise).load_balancer {
 voice_platform.tf is switched on (an empty list otherwise).  target_group_arn = aws_lb_target_group.api.arn
 voice_platform.tf is switched on (an empty list otherwise).  container_name   = "api"
 voice_platform.tf is switched on (an empty list otherwise).  container_port   = 3300
 voice_platform.tf is switched on (an empty list otherwise).}

 voice_platform.tf is switched on (an empty list otherwise).health_check_grace_period_seconds = 60

 voice_platform.tf is switched on (an empty list otherwise).# A bad image rolls itself back instead of flapping the whole service down.
 voice_platform.tf is switched on (an empty list otherwise).deployment_circuit_breaker {
 voice_platform.tf is switched on (an empty list otherwise).  enable   = true
 voice_platform.tf is switched on (an empty list otherwise).  rollback = true
 voice_platform.tf is switched on (an empty list otherwise).}

 voice_platform.tf is switched on (an empty list otherwise).lifecycle {
 voice_platform.tf is switched on (an empty list otherwise).  ignore_changes = [desired_count] # autoscaling owns it after creation
 voice_platform.tf is switched on (an empty list otherwise).}

 voice_platform.tf is switched on (an empty list otherwise).depends_on = [aws_lb_listener.https, aws_lb_listener.http_origin]
}

# --- autoscaling --------------------------------------------------------------

resource "aws_appautoscaling_target" "api" {
 voice_platform.tf is switched on (an empty list otherwise).service_namespace  = "ecs"
 voice_platform.tf is switched on (an empty list otherwise).resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
 voice_platform.tf is switched on (an empty list otherwise).scalable_dimension = "ecs:service:DesiredCount"
 voice_platform.tf is switched on (an empty list otherwise).min_capacity       = var.api_min_tasks
 voice_platform.tf is switched on (an empty list otherwise).max_capacity       = var.api_max_tasks
}

resource "aws_appautoscaling_policy" "api_cpu" {
 voice_platform.tf is switched on (an empty list otherwise).name               = "cpu-target"
 voice_platform.tf is switched on (an empty list otherwise).service_namespace  = aws_appautoscaling_target.api.service_namespace
 voice_platform.tf is switched on (an empty list otherwise).resource_id        = aws_appautoscaling_target.api.resource_id
 voice_platform.tf is switched on (an empty list otherwise).scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
 voice_platform.tf is switched on (an empty list otherwise).policy_type        = "TargetTrackingScaling"
 voice_platform.tf is switched on (an empty list otherwise).target_tracking_scaling_policy_configuration {
 voice_platform.tf is switched on (an empty list otherwise).  predefined_metric_specification {
 voice_platform.tf is switched on (an empty list otherwise).    predefined_metric_type = "ECSServiceAverageCPUUtilization"
 voice_platform.tf is switched on (an empty list otherwise).  }
 voice_platform.tf is switched on (an empty list otherwise).  target_value       = 60
 voice_platform.tf is switched on (an empty list otherwise).  scale_in_cooldown  = 300
 voice_platform.tf is switched on (an empty list otherwise).  scale_out_cooldown = 60
 voice_platform.tf is switched on (an empty list otherwise).}
}

resource "aws_appautoscaling_policy" "api_memory" {
 voice_platform.tf is switched on (an empty list otherwise).name               = "memory-target"
 voice_platform.tf is switched on (an empty list otherwise).service_namespace  = aws_appautoscaling_target.api.service_namespace
 voice_platform.tf is switched on (an empty list otherwise).resource_id        = aws_appautoscaling_target.api.resource_id
 voice_platform.tf is switched on (an empty list otherwise).scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
 voice_platform.tf is switched on (an empty list otherwise).policy_type        = "TargetTrackingScaling"
 voice_platform.tf is switched on (an empty list otherwise).target_tracking_scaling_policy_configuration {
 voice_platform.tf is switched on (an empty list otherwise).  predefined_metric_specification {
 voice_platform.tf is switched on (an empty list otherwise).    predefined_metric_type = "ECSServiceAverageMemoryUtilization"
 voice_platform.tf is switched on (an empty list otherwise).  }
 voice_platform.tf is switched on (an empty list otherwise).  target_value       = 75
 voice_platform.tf is switched on (an empty list otherwise).  scale_in_cooldown  = 300
 voice_platform.tf is switched on (an empty list otherwise).  scale_out_cooldown = 60
 voice_platform.tf is switched on (an empty list otherwise).}
}

# --- the daily retention run --------------------------------------------------
# The compose file's while-loop sidecar becomes a scheduled Fargate task: same
# image, command `python -m app.retention_job`, once a day at 03:00 IST. A
# failed run logs, alarms (observability.tf) and is retried tomorrow.

resource "aws_iam_role" "scheduler" {
 voice_platform.tf is switched on (an empty list otherwise).name = "${var.project}-scheduler"
 voice_platform.tf is switched on (an empty list otherwise).assume_role_policy = jsonencode({
 voice_platform.tf is switched on (an empty list otherwise).  Version = "2012-10-17"
 voice_platform.tf is switched on (an empty list otherwise).  Statement = [{
 voice_platform.tf is switched on (an empty list otherwise).    Effect    = "Allow"
 voice_platform.tf is switched on (an empty list otherwise).    Principal = { Service = "scheduler.amazonaws.com" }
 voice_platform.tf is switched on (an empty list otherwise).    Action    = "sts:AssumeRole"
 voice_platform.tf is switched on (an empty list otherwise).  }]
 voice_platform.tf is switched on (an empty list otherwise).})
}

resource "aws_iam_role_policy" "scheduler_run_task" {
 voice_platform.tf is switched on (an empty list otherwise).name = "run-retention-task"
 voice_platform.tf is switched on (an empty list otherwise).role = aws_iam_role.scheduler.id
 voice_platform.tf is switched on (an empty list otherwise).policy = jsonencode({
 voice_platform.tf is switched on (an empty list otherwise).  Version = "2012-10-17"
 voice_platform.tf is switched on (an empty list otherwise).  Statement = [
 voice_platform.tf is switched on (an empty list otherwise).    {
 voice_platform.tf is switched on (an empty list otherwise).      Effect   = "Allow"
 voice_platform.tf is switched on (an empty list otherwise).      Action   = ["ecs:RunTask"]
 voice_platform.tf is switched on (an empty list otherwise).      Resource = ["${aws_ecs_task_definition.api.arn_without_revision}:*"]
 voice_platform.tf is switched on (an empty list otherwise).    },
 voice_platform.tf is switched on (an empty list otherwise).    {
 voice_platform.tf is switched on (an empty list otherwise).      Effect   = "Allow"
 voice_platform.tf is switched on (an empty list otherwise).      Action   = ["iam:PassRole"]
 voice_platform.tf is switched on (an empty list otherwise).      Resource = [aws_iam_role.task_execution.arn, aws_iam_role.api_task.arn]
 voice_platform.tf is switched on (an empty list otherwise).    }
 voice_platform.tf is switched on (an empty list otherwise).  ]
 voice_platform.tf is switched on (an empty list otherwise).})
}

resource "aws_scheduler_schedule" "retention" {
 voice_platform.tf is switched on (an empty list otherwise).name                = "${var.project}-retention-daily"
 voice_platform.tf is switched on (an empty list otherwise).schedule_expression = "cron(30 21 * * ? *)" # 03:00 IST

 voice_platform.tf is switched on (an empty list otherwise).flexible_time_window {
 voice_platform.tf is switched on (an empty list otherwise).  mode = "OFF"
 voice_platform.tf is switched on (an empty list otherwise).}

 voice_platform.tf is switched on (an empty list otherwise).target {
 voice_platform.tf is switched on (an empty list otherwise).  arn      = aws_ecs_cluster.main.arn
 voice_platform.tf is switched on (an empty list otherwise).  role_arn = aws_iam_role.scheduler.arn

 voice_platform.tf is switched on (an empty list otherwise).  ecs_parameters {
 voice_platform.tf is switched on (an empty list otherwise).    task_definition_arn = aws_ecs_task_definition.api.arn
 voice_platform.tf is switched on (an empty list otherwise).    launch_type         = "FARGATE"
 voice_platform.tf is switched on (an empty list otherwise).    network_configuration {
 voice_platform.tf is switched on (an empty list otherwise).      subnets          = aws_subnet.private[*].id
 voice_platform.tf is switched on (an empty list otherwise).      security_groups  = [aws_security_group.api.id]
 voice_platform.tf is switched on (an empty list otherwise).      assign_public_ip = false
 voice_platform.tf is switched on (an empty list otherwise).    }
 voice_platform.tf is switched on (an empty list otherwise).  }

 voice_platform.tf is switched on (an empty list otherwise).  input = jsonencode({
 voice_platform.tf is switched on (an empty list otherwise).    containerOverrides = [{
 voice_platform.tf is switched on (an empty list otherwise).      name    = "api"
 voice_platform.tf is switched on (an empty list otherwise).      command = ["python", "-m", "app.retention_job"]
 voice_platform.tf is switched on (an empty list otherwise).    }]
 voice_platform.tf is switched on (an empty list otherwise).  })
 voice_platform.tf is switched on (an empty list otherwise).}
}
