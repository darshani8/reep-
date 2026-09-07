# Moving REEP's core stack from Terraform to CDK — the cutover runbook

Every resource in `infra/aws/` is live and holds real student data. This
procedure moves ownership of those resources from Terraform's state file to a
CloudFormation stack **without creating, replacing or deleting any of them**.
It is written to be run by one person, in order, with a rollback at every step.
It was reviewed adversarially before being written down in this form; the
things the review found are folded in and marked *(review)* where the reason
is not obvious.

**The two rules that make this safe. Read them twice.**

1. **Never delete a `.tf` file before Terraform has released its state.** A
   `terraform apply` against files that are gone and a state that still lists
   the database is a DESTROY of the database. Step 6 releases the state; the
   files go in step 7, after it.
2. **Never release Terraform's state before `cdk import` has succeeded and
   drift detection is clean.** Until then Terraform is the only thing that
   knows these resources exist.

**And one rule about mirrors:** the CDK template is reconciled *to reality*,
never the reverse. CloudFormation import does not compare properties, so a
wrong value imports fine and is then never corrected — the harden deploy only
sends properties whose *template* value changed. A mirror error at step 5 is
fixed in `stack.py`; it is never "fixed" by deploying.

The order is therefore: **import into CloudFormation → prove drift is clean →
release from Terraform → delete the files → harden (in two deploys).** Not one
step is skipped and not one is reordered.

## What you are moving

| Terraform (78 resources) | CDK stack | Region |
|---|---|---|
| everything in `infra/aws/` except the WAF | `reep-core` (`infra/cdk/reep_core/stack.py`) | ap-south-1 |
| `aws_wafv2_web_acl.edge` | `reep-edge-waf` (`edge.py`) | us-east-1 |
| *(new)* cross-region backup copy target | `reep-dr-vault` (`dr.py`) | ap-southeast-1 |

Four Terraform resources have **no CloudFormation counterpart and are dropped
on purpose**: `random_password.db`, `random_password.auth_secret`,
`aws_secretsmanager_secret_version.app`, `.external`. Their *values* live in
the two secrets already; the stack imports the secrets by ARN and never writes
a version. Six more collapse into bucket properties or are the two bucket
policies (imported as `AWS::S3::BucketPolicy`).

The `reep-core` stack has **two phases**, chosen by one context value:

- `-c phase=import` — a mirror of what exists and nothing else, carrying the
  *live* database values (single-AZ, 14-day retention, the current storage
  size) that `tools/import_map.py` reads from the state.
- `-c phase=harden` (the default) — the same stack plus every fix. It has a
  second switch, `hardenEcs`, so the database half and the ECS half deploy
  separately (step 9).

The synth tests (`infra/cdk/tests/test_core_synth.py`, 58 of them, no AWS)
prove: the import phase is a strict subset of harden; every physical name
matches the `.tf` files; the import template contains nothing that does not
exist (no generated ingress rules, no generated IAM policies); every type in it
has a registry identifier the tool knows; no `MasterUserPassword` can appear;
every resource in all three stacks is `Retain`.

## Step 0 — Preconditions (one afternoon, no risk)

Admin credentials for account 445363794125, from a machine with `terraform`,
`aws`, `node` 20+ and Python 3.12. **Every `cdk` command below runs with the
venv active** (`cdk.json` is `"app": "python app.py"`), and with the region
pinned — a profile pointed at another region imports nothing, confusingly.

```bash
export AWS_PROFILE=<admin>  CDK_DEFAULT_REGION=ap-south-1  CDK_DEFAULT_ACCOUNT=445363794125
cd infra/cdk
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements-dev.txt
npm install -g aws-cdk
python -m pytest -q                       # the synth guards, no AWS needed
cdk bootstrap aws://445363794125/ap-south-1 aws://445363794125/us-east-1 aws://445363794125/ap-southeast-1
```

**Remove the one script in the tree that deletes production by name** *(review)*:
`infra/aws/cleanup-orphans.sh` targets cluster `reep`, service `api`, log group
`/reep/api` and the five IAM roles — the production names — and after step 6
*everything* looks like an orphan to Terraform, which is exactly when someone
would reach for it. It is deleted in this repository; if you are on an older
checkout, `git rm` it before continuing.

Then, the facts that must be true before anything is imported:

```bash
cd infra/aws
terraform init -backend-config=backend.hcl
terraform plan -var-file=prod.tfvars -detailed-exitcode     # MUST exit 0: no drift, no pending change
```

(`alert_email` has no default, so `-var-file` is not optional.) If `plan`
proposes anything, resolve it first: importing a resource whose real state
differs from its Terraform state means the mirror in CDK is wrong too.

The voice-platform stack must already be deployed: it holds the grant that
lets `reep-github-deploy` assume the CDK bootstrap roles, which the browser
workflow in step 10 depends on.

Take one manual snapshot, by hand, that nothing automated will age out:

```bash
aws rds create-db-snapshot --db-instance-identifier reep-postgres \
  --db-snapshot-identifier "reep-postgres-pre-cdk-$(date -u +%Y%m%d)"
aws rds wait db-snapshot-available --db-snapshot-identifier "reep-postgres-pre-cdk-$(date -u +%Y%m%d)"
```

## Step 1 — Export the Terraform state and synthesise the mirror

```bash
cd infra/aws
terraform show -json > ../cdk/tf-state.json     # CONTAINS SECRET VALUES. gitignored. Delete after step 6.
cd ../cdk
cdk synth reep-core -c phase=import --quiet
```

## Step 2 — Build the import map from the state, never by hand

```bash
python tools/import_map.py tf-state.json cdk.out/reep-core.template.json
```

It writes nothing unless every check passes, then writes `import-map.json`
(the registry identifier, every part of a composite one, for each resource in
the import template) and merges into `cdk.context.json` everything the stack
must render identically: the random-suffix names, the secret ARNs, the AZs,
the prefix list, the WAF ARN — **and the variable-driven values** *(review)*:
the ALB certificate and origin domain, the CloudFront alias and certificate,
cpu/memory, min/max tasks, the instance class, the live Multi-AZ / retention /
storage size, the alert address, and the container environment. Without those
the mirror has the wrong *shape* (one HTTP listener where there are two).

Re-synthesise with the context now in place, then cross-check the identifier
keys against the only authoritative source:

```bash
cdk synth reep-core -c phase=import --quiet
aws cloudformation get-template-summary --template-body file://cdk.out/reep-core.template.json \
  --query 'ResourceIdentifierSummaries[].{Type:ResourceType,Keys:ResourceIdentifiers}' --output table
```

Every `Keys` entry must match the key set in `import-map.json` for that type.
A mismatch is a bug in `tools/import_map.py`'s `IDENTIFIERS` table; fix the
table, not the map.

Commit `cdk.context.json` and `import-map.json` — they are the audit record of
what was adopted, and neither is secret. **Never commit `tf-state.json`.**

## Step 3 — Rehearse on the WAF (one resource, one region)

```bash
CDK_DEFAULT_REGION=us-east-1 cdk import reep-edge-waf
# EdgeAcl's identifier is composite — Name | Id | Scope; the tool printed all three:
#   Name: reep-edge   Id: <from the state>   Scope: CLOUDFRONT
CDK_DEFAULT_REGION=us-east-1 cdk diff reep-edge-waf
```

The diff will show `[+]` for the `CDKMetadata` resource and the `WebAclArn`
output *and nothing else* — `cdk import` strips those two from what it
stores, so they are the expected residue *(review)*. Any property difference
means `edge.py` does not describe the ACL as it is: **fix `edge.py`**, re-run
`cdk import` after `delete-stack` (the ACL is `Retain`), and repeat. Do not
`cdk deploy` to make the diff go away — that changes the live WAF.

## Step 4 — Import the core stack

```bash
cdk import reep-core -c phase=import --resource-mapping import-map.json
```

CloudFormation validates every identifier before it adopts anything. If it
refuses a resource TYPE, remove that construct from the import phase in
`stack.py`, re-run from step 1, and record the resource here as *left
unmanaged*. Do not add it back in `harden` as a new resource unless creating
it a second time is harmless — for an internet-gateway attachment it is not.

## Step 5 — Prove the mirror is exact. This step is the whole point.

Two checks, and only the second one tells the truth *(review)*.

```bash
cdk diff reep-core -c phase=import
```

Expect `[+]` for `CDKMetadata` and the nine outputs, and **no property
changes on any resource**. A property change here is a value the next deploy
would send; for a create-only property (a security-group name, a subnet CIDR,
a task family) that is a REPLACEMENT.

Then drift detection, which compares the template to *reality*:

```bash
DRIFT=$(aws cloudformation detect-stack-drift --stack-name reep-core --query StackDriftDetectionId --output text)
until [ "$(aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id "$DRIFT" --query DetectionStatus --output text)" != DETECTION_IN_PROGRESS ]; do sleep 5; done
aws cloudformation describe-stack-resource-drifts --stack-name reep-core \
  --stack-resource-drift-status-filters MODIFIED DELETED \
  --query 'StackResourceDrifts[].{Id:LogicalResourceId,Status:StackResourceDriftStatus,Diffs:PropertyDifferences[].PropertyPath}' --output table
```

`NOT_CHECKED` rows are types CloudFormation cannot drift-check; ignore them.
`DELETED` must be empty. `MODIFIED` is acceptable **only** for these known,
harmless differences — anything else is a mirror error to fix in `stack.py`:

| Resource | Property | Why it differs |
|---|---|---|
| `AlbLogsBucket` policy | `PolicyDocument` | the L2 writes three statements on `/AWSLogs/<account>/*`; Terraform wrote one on `/*` (a superset) |
| `WebBucket` policy | `PolicyDocument.Statement[].Sid` | Terraform named it `CloudFrontRead`; the OAC origin does not set a Sid |
| `ApiRepo` | `LifecyclePolicy.LifecyclePolicyText` | JSON whitespace |
| `Db` | `EngineVersion` | template says `17`, the instance reports `17.x` — not re-sent |

Only when that table is the whole `MODIFIED` list is the mirror proven.
Terraform still manages everything; nothing has been changed yet. **This is
the last point at which nothing has happened.**

Rollback from here: `aws cloudformation delete-stack --stack-name reep-core`.
Every resource is `DeletionPolicy: Retain` — the database included; it is
*Retain*, not *Snapshot*, because Snapshot means delete-after-snapshot *(review)*
— so deleting the stack forgets the resources and touches none.

## Step 6 — Release Terraform's state

```bash
infra/cdk/tools/terraform_release.sh --i-have-run-cdk-import
```

The script checks that `reep-core` is `IMPORT_COMPLETE` before it does
anything, pulls a timestamped copy of the state (**keep it**), removes every
managed address in one `terraform state rm`, then runs `terraform plan` —
which must now propose to CREATE everything. That plan is the proof Terraform
no longer knows these resources. **Do not apply it.**

Rollback from here: `terraform state push terraform.tfstate.before-release.<stamp>`
restores Terraform's knowledge exactly, and `aws cloudformation delete-stack`
forgets the CDK side. Nothing on AWS has changed at either point.

Now delete the export: `rm infra/cdk/tf-state.json`.

## Step 7 — Delete the Terraform files, in a commit

```bash
git rm infra/aws/*.tf infra/aws/backend.hcl.example infra/aws/dev-setup-terraform.sh
# keep bootstrap-state.sh (the state bucket stays, holding the backup) and grant.sh (unrelated)
git commit -m "infra: Terraform released; reep-core is CloudFormation via CDK"
```

In the same commit, add `core` back to the `stack` choices in
`.github/workflows/cdk-deploy.yml` — it was removed so a browser click could
not create a second VPC before the import *(review)*.

From this commit on, `terraform apply` cannot destroy anything because there
is nothing for it to read.

## Step 8 — The DR vault (a new resource, created normally)

```bash
CDK_DEFAULT_REGION=ap-southeast-1 cdk deploy reep-dr-vault
# note the DrVaultArn output → cdk.context.json as drVaultArn
```

## Step 9 — Harden, in two deploys

Set the remaining context in `cdk.context.json`: `drVaultArn` from step 8,
`sesIdentityDomain=bgscet.ac.in` and `sesFromAddress` once the domain is
verified in SES, `alertEmail` if the tool did not find a subscription.

**9a — the database and backup half, at night IST** (the Multi-AZ conversion
builds a standby and dips performance while it syncs):

```bash
cdk diff reep-core -c hardenEcs=false
```

Expect: `Db` MultiAZ false→true and BackupRetentionPeriod 14→35; the vault's
`LockConfiguration`; the plan's `CopyActions`; the restore-testing plan and
selection; three backup alarms; `AWSBackupServiceRolePolicyForRestores` on the
backup role; the `send-mail` policy on the task role; tags. **No `Replace` on
anything.**

```bash
cdk deploy reep-core -c hardenEcs=false
```

**9b — the ECS half**, once 9a is `UPDATE_COMPLETE` and the instance shows
Multi-AZ:

```bash
cdk diff reep-core
```

Expect: a **new task-definition revision** (this *always* shows as a Replace
of `AWS::ECS::TaskDefinition` — the old revision is retained, and it is the
one Replace that is expected *(review)*), the target group's
`deregistration_delay` 30→600, the service's `MinimumHealthyPercent` 50→100
and the new task definition. Nothing else.

```bash
cdk deploy reep-core
```

**This deploy rolls the service itself** *(review)*: CloudFormation registers
the revision, updates the service, and waits for the deployment — with
100/200 the two old tasks stay healthy until two new ones are, and then each
old task lingers **600 s** in `draining` before it stops. Expect the deploy to
take 12–15 minutes. Watch `/ready` and the `reep-no-healthy-api` alarm.

The two halves are separate so that an ECS circuit-breaker rollback in 9b
cannot also undo the Multi-AZ conversion from 9a in the same stack update.

## Step 10 — What to check afterwards

- `deploy.yml` no longer uses `aws ecs wait services-stable` *(review)*: with a
  600 s drain, every deploy would have hit that waiter's 10-minute cap and
  reported failure on a successful roll. It now polls `describe-services`
  until one deployment remains and `runningCount == desiredCount`.
- `aws iam list-role-policies --role-name reep-api-task` lists `invoke-nova`,
  `send-mail` and the voice platform's policy — the voice stack's by-name
  attachment survives core owning the role.
- The next 03:00 IST backup job completes, and a *copy* job appears in
  `reep-vault-dr` in ap-southeast-1.
- The first Sunday 09:30 IST restore test runs and reports success; the three
  `reep-backup-*-failed` alarms stay OK.
- `cdk diff reep-core` shows no differences.
- CI's `cdk` job (the synth guards) is green.
- Run the **CDK deploy** workflow with `stack = core`, `action = diff` once
  from the browser: no differences.

## What this does NOT change

- The GitHub Actions **Deploy** workflow's names (`reep`, `reep-api`, `api`).
- Any secret value. The stack references the two secrets by ARN and never
  writes a version.
- The database's master password. See the synth test that refuses the
  template if `MasterUserPassword` appears.
- `DesiredCount` on the service: never sent, autoscaling owns it *(review)*.
- The state bucket `reep-tfstate-<account>`. It stays, holding the last state
  and the release backup.

## If something goes wrong in the middle

| You are at | Undo |
|---|---|
| after step 4/5, before 6 | `aws cloudformation delete-stack --stack-name reep-core` — every resource is Retain; Terraform still owns them |
| after step 6, before 7 | `terraform state push <backup>` and delete the CDK stack as above |
| after step 7 | `git revert` the deletion commit, then the row above |
| after 9a | `git revert` and `cdk deploy -c hardenEcs=false` walks the properties back. The governance vault lock is removable by an administrator; only the opt-in compliance lock is not |
| after 9b | `git revert` and `cdk deploy` — one more 12-minute roll |
