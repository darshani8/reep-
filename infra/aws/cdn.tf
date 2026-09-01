# CloudFront is the single public door: the SPA from S3 (via OAC), /api/* to
# the ALB — same-origin in the browser, so the httpOnly reep_session cookie
# design carries over from the dev proxy unchanged. WAF from security.tf sits
# in front; the interview WebSocket rides the /api/* behavior (CloudFront
# passes WebSocket upgrades on forwarded behaviors).

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${var.project}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

locals {
  # AWS managed policy ids (stable, documented constants).
  cache_optimized_id = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized
  cache_disabled_id  = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
  origin_all_viewer  = "216adef6-5c7f-47e4-b989-5492eafa07d3" # AllViewer
}

resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  comment             = "${var.project} - SPA + /api"
  default_root_object = "index.html"
  price_class         = "PriceClass_200" # includes India POPs
  web_acl_id          = aws_wafv2_web_acl.edge.arn
  aliases             = var.domain_name != "" ? [var.domain_name] : []

  origin {
    origin_id                = "web-s3"
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  origin {
    origin_id = "api-alb"
    # A name we own when we have one, so the origin certificate can match it;
    # the raw ELB hostname only when the origin is plain HTTP and nothing is
    # verified anyway.
    domain_name = var.alb_origin_domain != "" ? var.alb_origin_domain : aws_lb.main.dns_name
    custom_origin_config {
      http_port  = 80
      https_port = 443
      # https-only when the ALB holds a certificate; http-only when it cannot.
      origin_protocol_policy = local.alb_tls ? "https-only" : "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 60
    }
  }

  default_cache_behavior {
    target_origin_id       = "web-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.cache_optimized_id
    compress               = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_fallback.arn
    }
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "api-alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = local.cache_disabled_id
    origin_request_policy_id = local.origin_all_viewer # cookies + headers reach the api intact
    compress                 = true
  }

  # NO custom_error_response HERE, deliberately. It is distribution-wide --
  # it applies to EVERY behavior, /api/* included -- so mapping 403/404 to
  # index.html turned real API refusals into "200 text/html". A client then
  # sees res.ok true, parses a web page as JSON, and renders an empty screen
  # with no error: a mentor blocked by rule 2 got a blank page instead of
  # "you cannot see this student". The SPA fallback is done by the function
  # below, which is attached only to the S3 behavior.

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.domain_name == "" ? true : false
    acm_certificate_arn            = var.domain_name != "" ? var.cloudfront_acm_certificate_arn : null
    ssl_support_method             = var.domain_name != "" ? "sni-only" : null
    minimum_protocol_version       = var.domain_name != "" ? "TLSv1.2_2021" : "TLSv1"
  }

  # These are preconditions and not `check` blocks on purpose. A check block
  # WARNS and applies anyway; each of the mistakes below takes the whole API or
  # the whole site down, and a warning scrolls past in a plan with eight other
  # updates in it. Fail the plan.
  lifecycle {
    # THE ORIGIN MUST NOT BE THE DISTRIBUTION. Setting alb_origin_domain to the
    # public hostname reads as "the site is at reep.example.com, so that is the
    # origin" -- but that name is a CNAME to this distribution, so every
    # /api/* request is routed from CloudFront back into CloudFront. The edge
    # answers 403 "Bad request" without ever contacting the ALB, and because
    # the S3 behavior is untouched the SPA still loads perfectly: the dashboard
    # paints and nothing in it works, with no error anywhere that names a
    # cause. The origin needs its OWN hostname (origin.<domain>) pointed at the
    # alb_dns_name output -- see the alb_origin_domain variable.
    precondition {
      condition = var.alb_origin_domain == "" || (
        var.alb_origin_domain != var.domain_name &&
        !endswith(var.alb_origin_domain, ".cloudfront.net")
      )
      error_message = join(" ", [
        "alb_origin_domain (${var.alb_origin_domain}) is the public hostname or a",
        "CloudFront domain, so the /api/* origin would point back at this",
        "distribution and every API request would 403 at the edge while the SPA",
        "kept loading. It must be a SEPARATE name -- e.g. origin.${var.domain_name != "" ? var.domain_name : "<your-domain>"}",
        "-- with a DNS-only record pointing at the alb_dns_name output.",
      ])
    }

    # A custom domain without a certificate for it is a browser warning on every
    # visit. AWS rejects this too, but with an API error that names neither
    # variable, and the certificate must be in us-east-1 -- a regional cert that
    # works perfectly for the ALB is silently the wrong one here.
    precondition {
      condition = var.domain_name == "" || trimspace(var.cloudfront_acm_certificate_arn) != ""
      error_message = join(" ", [
        "domain_name is set to ${var.domain_name} but cloudfront_acm_certificate_arn",
        "is empty, so the distribution would serve its default *.cloudfront.net",
        "certificate and every visitor would get a name-mismatch warning. The",
        "certificate must be issued in us-east-1, NOT in var.region.",
      ])
    }
  }
}


check "origin_certificate_can_match" {
  assert {
    condition = !local.alb_tls || var.alb_origin_domain != ""
    error_message = join(" ", [
      "The ALB has a certificate but the CloudFront origin is still the raw",
      "*.elb.amazonaws.com hostname, which that certificate cannot cover.",
      "Set -var alb_origin_domain=origin.<your-domain> and point a CNAME at the",
      "alb_dns_name output, or expect CloudFront to fail origin TLS validation.",
    ])
  }
}


# The SPA owns its routes: a hard refresh on /student/badges asks S3 for a key
# that does not exist. This rewrites such a request to /index.html so the
# Angular router can take it.
#
# It is attached to the S3 behavior ONLY, which is the whole point: the /api/*
# behavior never runs it, so the API's own 401/403/404 reach the browser intact.
# A request is a file request (left alone) when its last segment contains a dot
# -- main-ABC123.js, styles.css, favicon.ico; everything else is a route.
resource "aws_cloudfront_function" "spa_fallback" {
  name    = "${var.project}-spa-fallback"
  runtime = "cloudfront-js-2.0"
  comment = "Serve index.html for SPA routes. Never runs on /api/*."
  publish = true
  code    = <<-JS
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      // Belt and braces: this function is not attached to the /api/* behavior,
      // but if it is ever attached more widely by mistake, the API must still
      // keep its own status codes.
      if (uri.startsWith('/api/')) {
        return request;
      }
      var last = uri.substring(uri.lastIndexOf('/') + 1);
      if (last.indexOf('.') === -1) {
        request.uri = '/index.html';
      }
      return request;
    }
  JS
}
