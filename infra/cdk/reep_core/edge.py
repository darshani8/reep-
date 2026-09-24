"""The CloudFront-scope WAF, which must live in us-east-1.

security.tf's `aws_wafv2_web_acl.edge` under the `aws.us_east_1` provider. A
CloudFormation stack is one region, so this is its own stack; the core stack
takes the ACL's ARN as the `wafWebAclArn` context value rather than a
cross-region reference, because cross-region references are Lambda-backed
custom resources and `cdk import` refuses a template that adds any.
"""

from __future__ import annotations

from typing import Any

from aws_cdk import CfnOutput, RemovalPolicy, Stack, Tags, aws_wafv2 as wafv2
from constructs import Construct


#: Rules inside AWSManagedRulesCommonRuleSet that are COUNTED rather than
#: allowed to block, and why each one is here.
#:
#: SizeRestrictions_BODY (2026-09-17). The rule blocks any request whose body
#: is over 8 KB, and it was blocking EVERY FILE UPLOAD IN THE PRODUCT: a
#: student's certificate on Skilling, the CV and photo the registration form
#: now requires, a leave attachment, a faculty signature, an alumni resume, an
#: upskilling certificate. Every one of those is a multipart POST far past 8 KB,
#: and the WAF answered it 403 at the edge -- before CloudFront, the ALB or the
#: API saw it -- with a body that is not JSON. The Angular client, reading no
#: `detail`, printed its fallback ("Certificate upload failed (PDF or JPEG, up
#: to 5 MB)."), so a student attaching a 2 MB JPEG was told their file was the
#: wrong kind. Nothing in the API could have caught it, and nothing in the
#: suite: the WAF exists only in front of the deployment.
#:
#: COUNT and not a scope-down: the API bounds every body itself
#: (`document_store.MAX_BYTES`, the per-handler `read(MAX + 1)`), so the edge
#: rule buys nothing there, and a scope-down that named the upload paths would
#: be a second list of them, maintained by hand in a file nobody opens when a
#: router adds a store. Counting keeps the metric -- the sampled requests still
#: show what would have been blocked -- and blocks nothing.
#:
#: The other body rules stay as they are: they inspect the first 16 KB of a
#: body for injection patterns, which a certificate does not carry, and none
#: of them refuses a request for being large.
COMMON_RULE_SET_COUNTED: tuple[str, ...] = ("SizeRestrictions_BODY",)


def _managed(
    name: str,
    priority: int,
    rule_name: str,
    metric: str,
    *,
    counted: tuple[str, ...] = (),
) -> wafv2.CfnWebACL.RuleProperty:
    overrides = [
        wafv2.CfnWebACL.RuleActionOverrideProperty(
            name=rule, action_to_use=wafv2.CfnWebACL.RuleActionProperty(count={})
        )
        for rule in counted
    ]
    return wafv2.CfnWebACL.RuleProperty(
        name=rule_name,
        priority=priority,
        override_action=wafv2.CfnWebACL.OverrideActionProperty(none={}),
        statement=wafv2.CfnWebACL.StatementProperty(
            managed_rule_group_statement=wafv2.CfnWebACL.ManagedRuleGroupStatementProperty(
                name=name,
                vendor_name="AWS",
                # Omitted entirely when empty: an empty list renders a property
                # the live ACL does not carry, which is a diff at the import
                # rehearsal for nothing.
                rule_action_overrides=overrides or None,
            )
        ),
        visibility_config=wafv2.CfnWebACL.VisibilityConfigProperty(
            cloud_watch_metrics_enabled=True, metric_name=metric, sampled_requests_enabled=True
        ),
    )


class EdgeWafStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, *, project: str = "reep", **kwargs: Any) -> None:
        super().__init__(scope, construct_id, **kwargs)
        # The same phase discipline the core stack applies, and for the same
        # reason: this ACL is ADOPTED from Terraform, which tagged it
        # ManagedBy=terraform. A mirror that says `cdk` makes step 3's diff —
        # the rehearsal, whose whole value is that it should come back showing
        # only CDKMetadata and the output — carry a property difference, and
        # invites the operator to "fix" edge.py when nothing is wrong with it.
        # The core stack was written this way from the start; the edge stack
        # was the one place the rule was not applied *(pre-import review,
        # 2026-09-07)*. Harden flips it, as it does everywhere else.
        phase = (self.node.try_get_context("phase") or "harden").strip().lower()
        # The upload fix rides the HARDEN phase only, like every other change
        # to an adopted resource: the import phase is a byte-identical mirror
        # of what Terraform built, and the rehearsal's whole value is that it
        # shows no property difference. The deployed ACL has been on `harden`
        # since the cutover, so `cdk-deploy.yml`'s `edge-waf` option is the
        # deploy that turns uploads back on.
        counted = COMMON_RULE_SET_COUNTED if phase == "harden" else ()

        acl = wafv2.CfnWebACL(
            self,
            "EdgeAcl",
            name=f"{project}-edge",
            scope="CLOUDFRONT",
            default_action=wafv2.CfnWebACL.DefaultActionProperty(allow={}),
            visibility_config=wafv2.CfnWebACL.VisibilityConfigProperty(
                cloud_watch_metrics_enabled=True, metric_name=f"{project}-waf", sampled_requests_enabled=True
            ),
            rules=[
                _managed("AWSManagedRulesCommonRuleSet", 1, "aws-common", f"{project}-waf-common", counted=counted),
                _managed("AWSManagedRulesKnownBadInputsRuleSet", 2, "aws-bad-inputs", f"{project}-waf-badinputs"),
                wafv2.CfnWebACL.RuleProperty(
                    name="rate-limit",
                    priority=3,
                    action=wafv2.CfnWebACL.RuleActionProperty(block={}),
                    statement=wafv2.CfnWebACL.StatementProperty(
                        rate_based_statement=wafv2.CfnWebACL.RateBasedStatementProperty(limit=2000, aggregate_key_type="IP")
                    ),
                    visibility_config=wafv2.CfnWebACL.VisibilityConfigProperty(
                        cloud_watch_metrics_enabled=True, metric_name=f"{project}-waf-rate", sampled_requests_enabled=True
                    ),
                ),
            ],
        )
        # The production ACL. A delete-stack must forget it, never delete it.
        acl.apply_removal_policy(RemovalPolicy.RETAIN)
        self.acl = acl
        CfnOutput(self, "WebAclArn", value=acl.attr_arn, description="Pass to the core stack as -c wafWebAclArn=…")

        # On the CHILDREN, never on the stack — see the long note at the end of
        # stack.py. `Tags.of(stack)` makes CDK send stack-level tags, and
        # CloudFormation refuses those on an import change set with
        # "you cannot modify or add [RoleArn, Tags]". That is how this very
        # stack's rehearsal import failed on 2026-09-07.
        for child in self.node.children:
            Tags.of(child).add("Project", project)
            Tags.of(child).add("ManagedBy", "cdk" if phase == "harden" else "terraform")
