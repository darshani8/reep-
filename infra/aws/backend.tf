# State lives in S3, not on whoever's laptop ran the first apply.
#
# A local terraform.tfstate is fine for exactly one operator on one machine and
# nothing else: the second person to apply has no idea what the first created,
# and a CloudShell session that gets reclaimed takes the record of a live
# production stack with it. Terraform then cannot manage what it built — it can
# only propose to build it a second time.
#
# The configuration is PARTIAL on purpose. A bucket name must be globally unique,
# so it necessarily contains the account id, and backend blocks cannot read
# variables or data sources. bootstrap-state.sh creates the bucket and the lock
# table and writes backend.hcl next to this file; init reads it:
#
#   terraform init -backend-config=backend.hcl
#
# The bucket and lock table are deliberately NOT resources in this stack. A
# state store cannot be described by the state it stores — destroying the stack
# would destroy the record of the destruction mid-flight.
terraform {
  backend "s3" {}
}
