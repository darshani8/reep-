#!/usr/bin/env bash
# Swagger/OpenAPI property-based API testing with Schemathesis.
#
# Schemathesis reads the API's own OpenAPI document (/openapi.json - what
# Swagger UI at /docs renders), GENERATES requests from every parameter schema
# (valid and invalid), and checks each response against the same document.
#
# READ-ONLY BY DESIGN: only GET operations. Fuzzing POST/PATCH/DELETE against a
# database people use would create, rewrite and delete real rows (and REEP's
# delete endpoints are deliberately destructive). Run write fuzzing only against
# a throwaway database.
#
#   testing/api/run_schemathesis.sh            # uses REEP_API, default http://localhost:3300
set -uo pipefail
cd "$(dirname "$0")/.."
API="${REEP_API:-http://localhost:3300}"
ST=".venv/bin/schemathesis"
OUT="results/api/schemathesis"
mkdir -p "$OUT"

cookie() {  # email password -> reep_session value
  curl -s -c - -X POST "$API/api/auth/login" -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" | awk '/reep_session/ {print $7}'
}

run() {  # name cookie path-regex
  local name=$1 c=$2 re=$3
  echo "== schemathesis: $name ($re)"
  "$ST" run "$API/openapi.json" \
    --include-method GET --include-path-regex "$re" \
    --exclude-path-regex '(\.csv|\.pdf|/export|/file|/audio|/paper|/report|^/api/v1/)' \
    --checks not_a_server_error,status_code_conformance,content_type_conformance,response_schema_conformance \
    --max-examples "${MAX_EXAMPLES:-15}" --request-timeout 30 --workers 1 \
    ${c:+-H "Cookie: reep_session=$c"} \
    --report junit,ndjson --report-dir "$OUT/$name" \
    --continue-on-failure 2>&1 | tee "$OUT/$name.txt" | tail -40
}

run public "" '^/(health|api/(auth/sso/status|register/hierarchy|interview/status))$'
run student "$(cookie loadtest105@bgscet.ac.in 'LoadTest#2026')" '^/api/student/'
run admin "$(cookie admin@bgscet.ac.in admin123)" '^/api/admin/'
