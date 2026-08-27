#!/usr/bin/env bash
# Install Terraform and its providers in an environment whose egress proxy
# blocks registry.terraform.io.
#
# `terraform init` fails there with "could not connect to registry.terraform.io
# ... Forbidden" -- the provider REGISTRY is blocked, but releases.hashicorp.com
# is not. So the provider zips are fetched from releases directly into a
# filesystem mirror and terraform is pointed at it via a CLI config file. Real
# operator machines and CloudShell do not need any of this; a plain
# `terraform init` works there.
#
# Versions must satisfy the constraints in versions.tf.
set -euo pipefail

TF_VERSION="${TF_VERSION:-1.9.8}"
AWS_PROVIDER="${AWS_PROVIDER:-5.82.2}"
RANDOM_PROVIDER="${RANDOM_PROVIDER:-3.6.3}"
PREFIX="${PREFIX:-$HOME/.local}"
MIRROR="$PREFIX/share/terraform-mirror"
REL="https://releases.hashicorp.com"

mkdir -p "$PREFIX/bin" "$MIRROR/registry.terraform.io/hashicorp"/{aws,random}

if ! command -v terraform >/dev/null 2>&1; then
  echo "fetching terraform ${TF_VERSION}"
  curl -fsSLo /tmp/tf.zip "$REL/terraform/${TF_VERSION}/terraform_${TF_VERSION}_linux_amd64.zip"
  unzip -oq /tmp/tf.zip -d "$PREFIX/bin" && rm -f /tmp/tf.zip "$PREFIX/bin/LICENSE.txt"
fi

fetch_provider() {
  local name="$1" version="$2"
  local zip="terraform-provider-${name}_${version}_linux_amd64.zip"
  local dest="$MIRROR/registry.terraform.io/hashicorp/${name}/${zip}"
  [ -f "$dest" ] && { echo "provider ${name} ${version} already mirrored"; return; }
  echo "fetching provider ${name} ${version}"
  curl -fsSLo "$dest" "$REL/terraform-provider-${name}/${version}/${zip}"
}
fetch_provider aws "$AWS_PROVIDER"
fetch_provider random "$RANDOM_PROVIDER"

cat > "$HOME/.terraformrc" <<EOF
provider_installation {
  filesystem_mirror {
    path    = "${MIRROR}"
    include = ["registry.terraform.io/*/*"]
  }
  direct { exclude = ["registry.terraform.io/*/*"] }
}
EOF

echo
echo "done. add ${PREFIX}/bin to PATH, then:"
echo "  export PATH=\"${PREFIX}/bin:\$PATH\""
echo "  ./bootstrap-state.sh && terraform init -backend-config=backend.hcl"
