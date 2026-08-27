#!/usr/bin/env bash
# ONE-OFF. Deletes the orphaned first-attempt stack in account 445363794125.
#
# On 2026-08-26 an apply ran from CloudShell against a LOCAL state file. That
# file was emptied by the migration to the S3 backend and no .backup survived,
# so ~25 live resources have no state anywhere: terraform can neither manage
# nor destroy them. They have to be deleted directly, and this is that.
#
# Every id below is HARD-CODED from an inventory of what actually remained
# after `terraform destroy` cleared the second attempt. No name globbing and no
# wildcards, so it cannot reach anything it was not written for -- in
# particular it never touches reep-tfstate-445363794125, which holds the state
# of the stack we are about to rebuild.
#
# Safe to re-run: every step tolerates its target being gone already.
set -u
R=ap-south-1
ok() { echo "  -> $*"; }
step() { echo; echo "== $* =="; }

step "ECS service + cluster"
aws ecs update-service --cluster reep --service api --desired-count 0 --region $R >/dev/null 2>&1 && ok "scaled api to 0"
aws ecs delete-service --cluster reep --service api --force --region $R >/dev/null 2>&1 && ok "deleted service api"
aws ecs wait services-inactive --cluster reep --services api --region $R 2>/dev/null && ok "service inactive"
aws ecs delete-cluster --cluster reep --region $R >/dev/null 2>&1 && ok "deleted cluster reep"

step "load balancer + target group"
ALB=arn:aws:elasticloadbalancing:$R:445363794125:loadbalancer/app/reep-alb/f1d75a84216595c9
aws elbv2 delete-load-balancer --region $R --load-balancer-arn $ALB 2>/dev/null && ok "deleting alb"
aws elbv2 wait load-balancers-deleted --region $R --load-balancer-arns $ALB 2>/dev/null && ok "alb gone"
aws elbv2 delete-target-group --region $R \
  --target-group-arn arn:aws:elasticloadbalancing:$R:445363794125:targetgroup/reep-api/8e172d6a0b420c5e 2>/dev/null && ok "deleted target group"

step "CloudFront (slow: disable must propagate before delete)"
D=E2NUYIQ6JKVC2W
if aws cloudfront get-distribution-config --id $D > /tmp/cf.json 2>/dev/null; then
  ETAG=$(jq -r .ETag /tmp/cf.json)
  if [ "$(jq -r .DistributionConfig.Enabled /tmp/cf.json)" = "true" ]; then
    jq '.DistributionConfig | .Enabled=false' /tmp/cf.json > /tmp/cf-off.json
    aws cloudfront update-distribution --id $D --distribution-config file:///tmp/cf-off.json --if-match "$ETAG" >/dev/null
    ok "disabled; waiting for propagation (this is the ~15 minute part)"
  fi
  aws cloudfront wait distribution-deployed --id $D && ok "deployed(disabled)"
  ETAG=$(aws cloudfront get-distribution-config --id $D --query ETag --output text)
  aws cloudfront delete-distribution --id $D --if-match "$ETAG" && ok "deleted distribution"
else
  ok "distribution already gone"
fi

step "WAF web ACL + origin access control (must follow CloudFront)"
LT=$(aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1 \
      --query "WebACLs[?Name=='reep-edge'].LockToken" --output text 2>/dev/null)
if [ -n "${LT:-}" ] && [ "$LT" != "None" ]; then
  aws wafv2 delete-web-acl --scope CLOUDFRONT --region us-east-1 \
    --name reep-edge --id 90b135d0-fe80-4846-a5f5-997264317d85 --lock-token "$LT" 2>/dev/null && ok "deleted web acl"
fi
OE=$(aws cloudfront get-origin-access-control --id E2W6W3Y0LQNAMV --query ETag --output text 2>/dev/null)
if [ -n "${OE:-}" ] && [ "$OE" != "None" ]; then
  aws cloudfront delete-origin-access-control --id E2W6W3Y0LQNAMV --if-match "$OE" 2>/dev/null && ok "deleted oac"
fi

step "NAT gateway + elastic IPs"
aws ec2 delete-nat-gateway --nat-gateway-id nat-0e9ee2daad662cdd6 --region $R >/dev/null 2>&1 && ok "deleting nat"
aws ec2 wait nat-gateway-deleted --nat-gateway-ids nat-0e9ee2daad662cdd6 --region $R 2>/dev/null && ok "nat gone"
for A in eipalloc-013bf09179387f632 eipalloc-0618ed250aae1e8f4; do
  aws ec2 release-address --allocation-id $A --region $R 2>/dev/null && ok "released $A"
done

step "EFS"
for M in fsmt-0473a11a74ef452ff fsmt-0d74d56d387957206; do
  aws efs delete-mount-target --mount-target-id $M --region $R 2>/dev/null && ok "deleted $M"
done
for i in $(seq 1 30); do
  n=$(aws efs describe-mount-targets --file-system-id fs-0f1b01a8e89c37a61 --region $R \
        --query 'length(MountTargets)' --output text 2>/dev/null || echo 0)
  [ "$n" = "0" ] && break
  sleep 10
done
aws efs delete-file-system --file-system-id fs-0f1b01a8e89c37a61 --region $R 2>/dev/null && ok "deleted file system"

step "security groups (retry: network interfaces release slowly)"
for i in 1 2 3 4 5 6; do
  left=0
  for G in sg-0b4ac9ec6338af2f3 sg-0525cdcb603fbc693 sg-027a0bde9b05a6527 sg-0bea46197050f4808; do
    aws ec2 describe-security-groups --group-ids $G --region $R >/dev/null 2>&1 || continue
    if aws ec2 delete-security-group --group-id $G --region $R 2>/dev/null; then ok "deleted $G"; else left=1; fi
  done
  [ "$left" = "0" ] && break
  echo "  (waiting for network interfaces to detach)"; sleep 20
done

step "VPC scaffolding"
for S in subnet-0ade192edc40d1b00 subnet-0deb4a8bcdce85369 subnet-06f0a169b390f17ab subnet-0fa71111200dfb3f5; do
  aws ec2 delete-subnet --subnet-id $S --region $R 2>/dev/null && ok "deleted $S"
done
for T in rtb-045a7084e6c2ae456 rtb-0b330d64d29bb221d; do
  aws ec2 delete-route-table --route-table-id $T --region $R 2>/dev/null && ok "deleted $T"
done
aws ec2 detach-internet-gateway --internet-gateway-id igw-00373120c228a8e4f \
  --vpc-id vpc-0130cbbd8521ec857 --region $R 2>/dev/null && ok "detached igw"
aws ec2 delete-internet-gateway --internet-gateway-id igw-00373120c228a8e4f --region $R 2>/dev/null && ok "deleted igw"
aws ec2 delete-vpc --vpc-id vpc-0130cbbd8521ec857 --region $R 2>/dev/null && ok "deleted vpc"

step "database subnet group, backups, scheduler, logs"
aws rds delete-db-subnet-group --db-subnet-group-name reep-db --region $R 2>/dev/null && ok "deleted db subnet group"
PLAN=4109160a-2f14-4367-8cbf-664b7be199e3
for S in $(aws backup list-backup-selections --backup-plan-id $PLAN --region $R \
            --query 'BackupSelectionsList[].SelectionId' --output text 2>/dev/null); do
  aws backup delete-backup-selection --backup-plan-id $PLAN --selection-id $S --region $R 2>/dev/null && ok "deleted selection $S"
done
aws backup delete-backup-plan --backup-plan-id $PLAN --region $R >/dev/null 2>&1 && ok "deleted backup plan"
aws backup delete-backup-vault --backup-vault-name reep-vault --region $R 2>/dev/null && ok "deleted backup vault"
aws scheduler delete-schedule --name reep-retention-daily --region $R 2>/dev/null && ok "deleted schedule"
aws logs delete-log-group --log-group-name /reep/api --region $R 2>/dev/null && ok "deleted log group"

step "IAM roles"
for ROLE in reep-api-task reep-backup reep-claude-observer reep-scheduler reep-task-execution; do
  for P in $(aws iam list-attached-role-policies --role-name $ROLE --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam detach-role-policy --role-name $ROLE --policy-arn "$P" 2>/dev/null
  done
  for P in $(aws iam list-role-policies --role-name $ROLE --query 'PolicyNames[]' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name $ROLE --policy-name "$P" 2>/dev/null
  done
  aws iam delete-role --role-name $ROLE 2>/dev/null && ok "deleted role $ROLE"
done

step "ECR, secrets, buckets"
aws ecr delete-repository --repository-name reep/api --force --region $R >/dev/null 2>&1 && ok "deleted ecr repo"
for S in reep/external-20260826190448061800000003 reep/app-20260826190448674300000005; do
  aws secretsmanager delete-secret --secret-id "$S" --force-delete-without-recovery --region $R >/dev/null 2>&1 && ok "deleted secret $S"
done
# NOTE: reep-tfstate-445363794125 is deliberately NOT in this list.
for B in reep-alb-logs-20260826190447167000000002 reep-web-20260826190446773400000001; do
  aws s3 rb s3://$B --force >/dev/null 2>&1 && ok "removed bucket $B"
done

echo
echo "done. verify with:"
echo "  aws ec2 describe-vpcs --region $R --query 'Vpcs[?!IsDefault]'"
