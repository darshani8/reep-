# OUTBOUND EMAIL, FOR ONE PURPOSE: the 6-digit codes behind email & password
# sign-in (docs/email-password-sign-in.md). Everything here is conditional on
# var.mail_from_domain — an INFRASTRUCTURE fact (an identity exists), never an
# application setting: the grant below is scoped to a resource that only exists
# when the identity does, which is the one honest reason ecs.tf's "granted
# unconditionally" rule does not apply to it. Blank domain = none of this, and
# the API's EMAIL_TRANSPORT is blank too (ecs.tf), so the password door stays
# shut.
#
# DNS is not managed by this stack. The DKIM CNAMEs are surfaced through the
# dns_records_to_create output (outputs.tf) for a human to add — grey cloud —
# and `terraform output ses_identity` answers whether they have landed.
#
# Custom MAIL FROM (aws_sesv2_email_identity_mail_from_attributes: an MX and a
# TXT on the college zone) is deliberately NOT here. Easy DKIM alone aligns the
# From domain under DMARC's default relaxed alignment; it is the first follow-up
# if Google Workspace quarantines the mail, not a day-one requirement.

locals {
  mail_on = var.mail_from_domain != ""
  # The bare address out of 'REEP <no-reply@bgscet.ac.in>' (or a bare address).
  # This is what the IAM condition pins and what SES compares against the From
  # header; an unparseable value becomes "" and the precondition below refuses
  # the apply rather than minting a grant nothing can satisfy.
  mail_address = local.mail_on ? try(regex("<?([^<>\\s]+@[^<>\\s]+)>?$", var.mail_from_address)[0], "") : ""
}

# A bounce is the one delivery failure neither mail_logs nor the log tripwire
# can see: SES accepted the message, so the API wrote SENT and logged nothing,
# and the student still received nothing. Reputation metrics plus an event
# destination on the alerts topic are how that becomes visible.
resource "aws_sesv2_configuration_set" "mail" {
  count                  = local.mail_on ? 1 : 0
  configuration_set_name = "${var.project}-mail"

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }
}

resource "aws_sesv2_configuration_set_event_destination" "alerts" {
  count                  = local.mail_on ? 1 : 0
  configuration_set_name = aws_sesv2_configuration_set.mail[0].configuration_set_name
  event_destination_name = "alerts"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT", "REJECT"]

    sns_destination {
      topic_arn = aws_sns_topic.alerts.arn
    }
  }
}

# A DOMAIN identity, not an address: inside the SES sandbox a verified domain
# makes every recipient on it deliverable, which is what lets a pilot on the
# roster domain run before production access is granted. Easy DKIM — SES holds
# the key and rotates it; the operator adds three CNAMEs once.
resource "aws_sesv2_email_identity" "mail" {
  count                  = local.mail_on ? 1 : 0
  email_identity         = var.mail_from_domain
  configuration_set_name = aws_sesv2_configuration_set.mail[0].configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# ses:SendEmail only, on THIS identity and THIS configuration set, from THIS
# address. No SendRawEmail (the client sends Simple content), no identity
# management, no account-level calls. A compromised task can send a plain-text
# message from no-reply@ and nothing else. Modelled on aws_iam_role_policy
# .api_bedrock in ecs.tf; the difference is the count, and the comment at the
# top of this file says why that is allowed here.
resource "aws_iam_role_policy" "api_ses" {
  count = local.mail_on ? 1 : 0
  name  = "send-sign-in-codes"
  role  = aws_iam_role.api_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ses:SendEmail"]
      Resource = [aws_sesv2_email_identity.mail[0].arn, aws_sesv2_configuration_set.mail[0].arn]
      Condition = {
        StringEquals = { "ses:FromAddress" = local.mail_address }
      }
    }]
  })

  lifecycle {
    # The grant is worth nothing if the address it pins is not one the identity
    # can send as: SES refuses the send, the API logs the ERROR tripwire behind a
    # 202, and every student is told a code is on its way. Refuse at plan time
    # instead. A subdomain of the identity (no-reply@mail.<domain>) is fine —
    # a verified domain covers its subdomains.
    precondition {
      condition     = local.mail_address != "" && (endswith(local.mail_address, "@${var.mail_from_domain}") || endswith(local.mail_address, ".${var.mail_from_domain}"))
      error_message = "mail_from_address must be an address under mail_from_domain, e.g. 'REEP <no-reply@${var.mail_from_domain}>' (got '${var.mail_from_address}')."
    }
  }
}
