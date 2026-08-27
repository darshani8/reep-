resource "aws_lb" "main" {
  name               = "${var.project}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  access_logs {
    bucket  = aws_s3_bucket.alb_logs.bucket
    enabled = true
  }

  drop_invalid_header_fields = true
  idle_timeout               = 300 # the interview WebSocket rides this listener
}

resource "aws_lb_target_group" "api" {
  name        = "${var.project}-api"
  port        = 3300
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  health_check {
    path                = "/health"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }

  deregistration_delay = 30
}

locals {
  # The certificate decides the shape of the front door. With one, port 80 only
  # redirects and all traffic arrives on 443; without one, port 80 IS the door
  # and CloudFront is told to speak HTTP to it.
  alb_tls = trimspace(var.alb_acm_certificate_arn) != ""
}

# WITH a certificate: 80 exists only to bounce callers to 443.
resource "aws_lb_listener" "http_redirect" {
  count             = local.alb_tls ? 1 : 0
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = local.alb_tls ? 1 : 0
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.alb_acm_certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# WITHOUT a certificate: 80 forwards to the API. Throwaway environments only —
# see the variable's description for what this costs you.
resource "aws_lb_listener" "http_origin" {
  count             = local.alb_tls ? 0 : 1
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
