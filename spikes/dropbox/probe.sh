#!/usr/bin/env bash
# Dropbox platform probes as executable assertions (#19).
#
# Verifies the facts the provider design rests on, against the live API:
#   P1  client-chosen paths, implicit dirs, overwrite-in-place
#   P2  folder shared link minting (public, revocable)
#   P3  app-auth (key:secret, NO user token) fetch of a child by relative
#       path under a folder link; no-auth refused; unknown names denied
#       without an existence oracle
#   P4  revocation is hard, retroactive, immediate; re-mint yields a new URL
#   P5  ancestor-link rule: a parent-folder link still serves a child whose
#       own container link was revoked -> mint links only on leaves
#   P6  expiring links are gated on free accounts (settings_error)
#   P7  CORS: API host preflights cleanly (browser recipients); the
#       tokenless dl=1 hop on www.dropbox.com carries no ACAO (native-only)
#   P8  a file link survives overwrite-in-place and serves new content
#       (the pickup-object pattern)
#   P9  tokenless dl=1 file fetch works natively; folder dl=1 is a zip
#
# Usage: probe.sh [creds.json]   with {appKey, appSecret, accessToken}.
# Creates everything under a random /probe-* root in the app folder and
# deletes it on exit.

set -euo pipefail

CREDS="${1:-${DROPBOX_APP_JSON:-$HOME/tmp/dropbox-app.json}}"
KEY=$(jq -r .appKey "$CREDS")
SECRET=$(jq -r .appSecret "$CREDS")
TOK=$(jq -r .accessToken "$CREDS")
ROOT="/probe-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"

PASS=0
FAIL=0
note() { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS + 1)); note "  ok: $*"; }
bad()  { FAIL=$((FAIL + 1)); note "  FAIL: $*"; }
assert_eq() { # got expected label
    if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got: $1, want: $2)"; fi
}
assert_contains() { # haystack needle label
    case "$1" in *"$2"*) ok "$3" ;; *) bad "$3 (missing '$2' in: ${1:0:120})" ;; esac
}

api() { # endpoint json -> sets BODY and CODE
    local out
    out=$(curl -s -w '\n%{http_code}' -X POST "https://api.dropboxapi.com/2/$1" \
        -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" -d "$2")
    CODE=${out##*$'\n'}
    BODY=${out%$'\n'*}
}

upload() { # path body -> sets BODY and CODE
    local out
    out=$(curl -s -w '\n%{http_code}' -X POST "https://content.dropboxapi.com/2/files/upload" \
        -H "Authorization: Bearer $TOK" -H "Content-Type: application/octet-stream" \
        -H "Dropbox-API-Arg: {\"path\":\"$1\",\"mode\":\"overwrite\"}" --data-binary "$2")
    CODE=${out##*$'\n'}
    BODY=${out%$'\n'*}
}

link_fetch() { # url [path] -> sets BODY and CODE, app auth
    local arg="{\"url\":\"$1\"}"
    [ $# -gt 1 ] && arg="{\"url\":\"$1\",\"path\":\"$2\"}"
    local out
    out=$(curl -s -w '\n%{http_code}' -X POST "https://content.dropboxapi.com/2/sharing/get_shared_link_file" \
        -u "$KEY:$SECRET" -H "Dropbox-API-Arg: $arg")
    CODE=${out##*$'\n'}
    BODY=${out%$'\n'*}
}

cleanup() { api files/delete_v2 "{\"path\":\"$ROOT\"}" >/dev/null || true; }
trap cleanup EXIT

note "P1: path-addressed writes, implicit dirs, overwrite-in-place"
upload "$ROOT/doc1/chunk-000102.bin" 'chunk v1 content'
assert_eq "$CODE" 200 "upload at client-chosen path"
assert_contains "$BODY" content_hash "upload returns metadata"
upload "$ROOT/doc1/chunk-000102.bin" 'chunk v2 OVERWRITTEN'
assert_eq "$CODE" 200 "overwrite in place"
upload "$ROOT/doc1/manifest-dev1.bin" 'manifest v1'
assert_eq "$CODE" 200 "second object"

note "P2: folder link minting"
api sharing/create_shared_link_with_settings \
    "{\"path\":\"$ROOT/doc1\",\"settings\":{\"requested_visibility\":\"public\"}}"
assert_eq "$CODE" 200 "mint folder link"
DOC_LINK=$(printf '%s' "$BODY" | jq -r .url)
assert_contains "$DOC_LINK" "/scl/fo/" "folder link shape"
assert_eq "$(printf '%s' "$BODY" | jq -r .link_permissions.can_revoke)" true "link is revocable"

note "P3: app-auth account-less fetch by derived relative path"
link_fetch "$DOC_LINK" "/chunk-000102.bin"
assert_eq "$CODE" 200 "app-auth child fetch status"
assert_eq "$BODY" 'chunk v2 OVERWRITTEN' "app-auth child fetch content (post-overwrite)"
out=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "https://content.dropboxapi.com/2/sharing/get_shared_link_file" \
    -H "Dropbox-API-Arg: {\"url\":\"$DOC_LINK\",\"path\":\"/chunk-000102.bin\"}")
assert_eq "$out" 401 "no-auth fetch refused"
link_fetch "$DOC_LINK" "/nope.bin"
assert_eq "$CODE" 409 "unknown name refused"
assert_contains "$BODY" shared_link_access_denied "denial without existence oracle"

note "P8: file link survives overwrite (pickup-object pattern)"
api sharing/create_shared_link_with_settings \
    "{\"path\":\"$ROOT/doc1/manifest-dev1.bin\",\"settings\":{\"requested_visibility\":\"public\"}}"
assert_eq "$CODE" 200 "mint file link"
FILE_LINK=$(printf '%s' "$BODY" | jq -r .url)
upload "$ROOT/doc1/manifest-dev1.bin" 'manifest v2 ROTATED'
link_fetch "$FILE_LINK"
assert_eq "$CODE" 200 "file link still serves after overwrite"
assert_eq "$BODY" 'manifest v2 ROTATED' "file link serves NEW content"

note "P9: tokenless paths (native-only niceties)"
dl=$(printf '%s' "$FILE_LINK" | sed 's/dl=0/dl=1/')
body=$(curl -sL "$dl")
assert_eq "$BODY" 'manifest v2 ROTATED' "tokenless dl=1 file fetch"
ctype=$(curl -sL -o /dev/null -w '%{content_type}' "$(printf '%s' "$DOC_LINK" | sed 's/dl=0/dl=1/')")
assert_contains "$ctype" zip "tokenless folder dl=1 is a zip (no per-child access)"

note "P4: revocation is hard, retroactive, immediate; re-mint is fresh"
api sharing/revoke_shared_link "{\"url\":\"$DOC_LINK\"}"
assert_eq "$CODE" 200 "revoke folder link"
t0=$(date +%s%N)
link_fetch "$DOC_LINK" "/chunk-000102.bin"
t1=$(date +%s%N)
assert_eq "$CODE" 409 "post-revoke fetch refused ($(( (t1 - t0) / 1000000 ))ms after revoke)"
api sharing/create_shared_link_with_settings \
    "{\"path\":\"$ROOT/doc1\",\"settings\":{\"requested_visibility\":\"public\"}}"
NEW_LINK=$(printf '%s' "$BODY" | jq -r .url)
if [ "$NEW_LINK" != "$DOC_LINK" ] && [ -n "$NEW_LINK" ] && [ "$NEW_LINK" != null ]; then
    ok "re-mint yields a different URL"
else
    bad "re-mint did not yield a fresh URL"
fi
link_fetch "$NEW_LINK" "/chunk-000102.bin"
assert_eq "$BODY" 'chunk v2 OVERWRITTEN' "new link serves (rotation without data movement)"

note "P5: ancestor-link rule (mint links only on leaves)"
api sharing/create_shared_link_with_settings \
    "{\"path\":\"$ROOT\",\"settings\":{\"requested_visibility\":\"public\"}}"
PARENT_LINK=$(printf '%s' "$BODY" | jq -r .url)
api sharing/revoke_shared_link "{\"url\":\"$NEW_LINK\"}"
link_fetch "$PARENT_LINK" "/doc1/chunk-000102.bin"
assert_eq "$CODE" 200 "parent link serves child despite child-link revocation"
api sharing/revoke_shared_link "{\"url\":\"$PARENT_LINK\"}"

note "P6: expiring links gated on free tier"
api sharing/create_shared_link_with_settings \
    "{\"path\":\"$ROOT/doc1/chunk-000102.bin\",\"settings\":{\"requested_visibility\":\"public\",\"expires\":\"2030-01-01T00:00:00Z\"}}"
assert_eq "$CODE" 409 "expires refused"
assert_contains "$BODY" settings_error/not_authorized "paid-tier gating error shape"

note "P7: CORS"
hdrs=$(curl -s -X OPTIONS "https://content.dropboxapi.com/2/sharing/get_shared_link_file" \
    -H "Origin: https://app.example" -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: authorization,dropbox-api-arg" -D - -o /dev/null)
assert_contains "$hdrs" "access-control-allow-origin: https://app.example" "API preflight allows origin"
assert_contains "$hdrs" "Dropbox-API-Arg" "API preflight allows Dropbox-API-Arg"
hop1=$(curl -s "$dl" -H "Origin: https://app.example" -D - -o /dev/null | head -20)
if printf '%s' "$hop1" | grep -qi '^access-control-allow-origin'; then
    bad "www.dropbox.com dl=1 hop unexpectedly grew ACAO (browser path may work now)"
else
    ok "tokenless dl=1 first hop has no ACAO (native-only, as recorded)"
fi

note ""
note "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
