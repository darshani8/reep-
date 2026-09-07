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


def _managed(name: str, priority: int, rule_name: str, metric: str) -> wafv2.CfnWebACL.RuleProperty:
    return wafv2.CfnWebACL.RuleProperty(
        name=rule_name,
        priority=priority,
        override_action=wafv2.CfnWebACL.OverrideActionProperty(none={}),
        statement=wafv2.CfnWebACL.StatementProperty(
            managed_rule_group_statement=wafv2.CfnWebACL.ManagedRuleGroupStatementProperty(name=name, vendor_name="AWS")
        ),
        visibility_config=wafv2.CfnWebACL.VisibilityConfigProperty(
            cloud_watch_metrics_enabled=True, metric_name=metric, sampled_requests_enabled=True
        ),
    )


class EdgeWafStack(Stack):
    def __init__(self, scope: Construct, construct_id: str, *, project: str = "reep", **kwargs: Any) -> None:
        super().__init__(scope, construct_id, **kwargs)
        Tags.of(self).add("Project", project)
        Tags.of(self).add("ManagedBy", "cdk")

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
                _managed("AWSManagedRulesCommonRuleSet", 1, "aws-common", f"{project}-waf-common"),
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
