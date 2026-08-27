variable "region" {
  description = "Home region for everything except CloudFront's cert/WAF (us-east-1)."
  type        = string
  default     = "ap-south-1" # Mumbai — closest to the Bengaluru cohort
}

variable "project" {
  type    = string
  default = "reep"
}

# --- edge / domain -----------------------------------------------------------

variable "domain_name" {
  description = "Public domain the dashboard serves on (e.g. reep.bgscet.ac.in). Empty = use the CloudFront default domain."
  type        = string
  default     = ""
}

variable "cloudfront_acm_certificate_arn" {
  description = "ACM certificate ARN IN us-east-1 covering domain_name. Required when domain_name is set."
  type        = string
  default     = ""
}

variable "alb_acm_certificate_arn" {
  description = <<-EOT
    ACM certificate ARN IN var.region for the ALB's HTTPS listener, so the
    CloudFront->ALB hop is encrypted. RECOMMENDED — and it needs a domain you
    control, because a public CA will not issue for *.elb.amazonaws.com.

    LEAVE EMPTY only for a throwaway environment with no real student data: the
    ALB then listens on plain HTTP and CloudFront talks to it over HTTP. The
    browser->CloudFront leg is still TLS, but the origin leg is not, so the
    ALB is simultaneously locked down to CloudFront's own IP ranges (see
    restrict_alb_to_cloudfront) rather than being reachable from anywhere.
  EOT
  type        = string
  default     = ""
}

variable "alb_origin_domain" {
  description = <<-EOT
    A hostname in YOUR domain that resolves to the load balancer, e.g.
    origin.reep.example.com. Set this whenever alb_acm_certificate_arn is set.

    WHY IT IS NOT OPTIONAL IN PRACTICE: when CloudFront talks to a custom origin
    over HTTPS it verifies the origin's certificate against the ORIGIN DOMAIN
    NAME. Point the origin at the raw *.elb.amazonaws.com hostname and no
    certificate you can obtain will ever match it — a public CA will not issue
    for Amazon's domain. So the origin gets a name you own, the certificate is
    issued for that name, and the two agree.

    After `terraform apply`, create a CNAME for this name pointing at the
    `alb_dns_name` output (in Cloudflare: DNS only, grey cloud — proxying it
    puts a second CDN in front of your origin).
  EOT
  type        = string
  default     = ""
}

variable "restrict_alb_to_cloudfront" {
  description = <<-EOT
    Admit only CloudFront's published origin-facing IP ranges to the ALB, via
    the AWS-managed prefix list. Defence in depth in both modes: without it,
    anyone who learns the ALB's DNS name reaches the API DIRECTLY, skipping the
    WAF rules and the rate limit that CloudFront enforces.

    Set false only if the managed prefix list is unavailable in your region and
    the apply fails on the data source.
  EOT
  type        = bool
  default     = true
}

# --- api service sizing / autoscaling ---------------------------------------

variable "api_cpu" {
  type    = number
  default = 512
}

variable "api_memory" {
  type    = number
  default = 1024
}

variable "api_min_tasks" {
  description = "Autoscaling floor. Two on purpose: one task restarting must never be an outage."
  type        = number
  default     = 2
}

variable "api_max_tasks" {
  type    = number
  default = 10
}

# --- database ----------------------------------------------------------------

variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "db_multi_az" {
  description = "Standby in a second AZ. Costs double; turn on when the cohort depends on it."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  type    = number
  default = 14
}

# --- application behaviour ----------------------------------------------------

variable "bedrock_model" {
  description = "Amazon Nova model/inference-profile id the LLM adapter uses (app/ai/llm.py). Empty disables Bedrock."
  type        = string
  default     = "apac.amazon.nova-pro-v1:0"
}

variable "allow_remote_student_data" {
  description = "Rule 1's egress flag. 'true' lets student-data paths (resume brief) reach Bedrock — reasonable in-account, still an explicit operator decision."
  type        = string
  default     = "true"
}

variable "interview_recording_enabled" {
  description = "Capture per-speaker WAVs of AI interviews (the call recorder). Bytes are written only for students whose consent grant ticks store-audio."
  type        = string
  default     = "true"
}

# --- alerting ----------------------------------------------------------------

variable "alert_email" {
  description = "Where CloudWatch infra alarms page to. App-level errors and traces live in Sentry."
  type        = string
}

variable "observer_principal_arn" {
  description = "IAM principal allowed to assume the read-only reep-claude-observer role (e.g. your user ARN). Empty = the account root."
  type        = string
  default     = ""
}
