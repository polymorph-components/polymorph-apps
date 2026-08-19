#!/usr/bin/env bash
# Source-level invariant checks for the demo chrome (#22 ruling table).
#
# These are the invariants that are cheap to STATE and expensive to
# notice the loss of: each one is a property of the source text, so a
# refactor that quietly breaks it fails here instead of failing in a
# browser six weeks later. They are not a substitute for the reasoning in
# host/demo.ts's comments — they are the tripwires on it.
#
# Run from anywhere; paths resolve relative to spikes/demo.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

fail=0

ok() { printf '  ok   %s\n' "$1"; }
bad() {
  printf '  FAIL %s\n' "$1"
  fail=1
}

# --- (a) the petname never crosses the frame seam ---------------------------
# The user's own word for a component is chrome-side state. A component
# that could read it could impersonate the user's trust in itself; a
# component that could influence it could put attacker-chosen words into
# chrome's own voice. So it must not appear anywhere on the seam.
echo "[1/4] petname never crosses the frame seam"
echo "      (chrome's word for a component is never readable or influenceable by it)"
hits=$(grep -n "petname" host/frame-backend.ts host/frame.ts web/frame.html 2>/dev/null)
if [ -n "$hits" ]; then
  bad "petname appears on the frame seam:"
  printf '%s\n' "$hits" | sed 's/^/       /'
else
  ok "no petname reference in host/frame-backend.ts, host/frame.ts, web/frame.html"
fi

# --- (b) chrome never writes the word "password" ---------------------------
# A panel may DECLARE a credential kind; chrome renders the field with
# chrome's own words. "password" is never one of them: the moment chrome's
# pixels ask for a password on a panel's behalf, the panel has borrowed
# chrome's authority. The ONLY admissible occurrence is the bare token
# "password" as an input-masking type — never inside a sentence.
# Comments are exempt: they explain the rule rather than render it.
echo "[2/4] chrome never renders the word \"password\""
echo "      (chrome's labels are chrome's own; a panel must never borrow them)"
prose=$(sed -E 's@^[[:space:]]*(//|\*|/\*).*@@' host/demo.ts |
  grep -oiE '"[^"]*password[^"]*"' | grep -vx '"password"')
if [ -n "$prose" ]; then
  bad "a chrome-rendered string literal contains \"password\":"
  printf '%s\n' "$prose" | sed 's/^/       /'
else
  ok "no string literal in host/demo.ts spells password inside prose"
fi
# And the bare token is only ever the masking type, never a label.
misuse=$(grep -n '"password"' host/demo.ts |
  grep -vE '^[[:space:]]*[0-9]+:[[:space:]]*(//|\*)' |
  grep -vE 'type: "password"|"text" \| "password"')
if [ -n "$misuse" ]; then
  bad "\"password\" used somewhere other than the input-masking type:"
  printf '%s\n' "$misuse" | sed 's/^/       /'
else
  ok "the bare \"password\" token appears only as an input type"
fi

# --- (c) the anchor colour is never ambient --------------------------------
# --chrome-bg carries the user's personal, undisclosed anchor colour. Set
# on the document root it INHERITS into every app region, so a component
# that ever gained a style attribute (or a class resolving the variable)
# could paint chrome's exact colour without reading it. Scope keeps the
# secrecy structural instead of a property of the allowlist.
echo "[3/4] the anchor colour is never made ambient"
echo "      (--chrome-bg is scoped to chrome's own elements; inheriting it would disclose it)"
ambient=$(grep -nE '(documentElement|:root)[^\n]*--chrome-bg' host/*.ts 2>/dev/null)
if [ -n "$ambient" ]; then
  bad "--chrome-bg applied to the document root in host/*.ts:"
  printf '%s\n' "$ambient" | sed 's/^/       /'
else
  ok "no host/*.ts line sets --chrome-bg on documentElement/:root"
fi
rootdecl=$(awk '
  /:root/ { inroot = 1 }
  inroot && /--chrome-bg[[:space:]]*:/ { printf "%d: %s\n", NR, $0 }
  /}/ { inroot = 0 }
' web/index.html)
if [ -n "$rootdecl" ]; then
  bad "--chrome-bg declared inside a :root block in web/index.html:"
  printf '%s\n' "$rootdecl" | sed 's/^/       /'
else
  ok "web/index.html declares --chrome-bg in no :root block"
fi

# --- (d) no key is ever exported from chrome ------------------------------
# An escrowed signing credential is stored as a NON-EXTRACTABLE WebCrypto
# handle (host/keystore.ts): `crypto.subtle.exportKey` on it throws by
# construction, so the guarantee is the platform's rather than ours. What
# this check defends is the *construction* — a later "just for debugging"
# export path, or an import that quietly passes extractable: true and a
# matching read-back, would turn the handle back into a bearer string.
# Banning the verb outright from host code keeps the property one grep
# wide instead of a review argument. Comments are exempt: they explain
# the rule rather than perform it.
echo "[4/4] chrome never exports a key"
echo "      (escrowed signing keys are non-extractable; nothing reads them back)"
exported=$(grep -n "exportKey" host/*.ts 2>/dev/null |
  grep -vE "^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)")
if [ -n "$exported" ]; then
  bad "exportKey appears in host code:"
  printf '%s\n' "$exported" | sed 's/^/       /'
else
  ok "no host/*.ts line calls exportKey"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "invariant check FAILED — see above (#22 ruling table)"
  exit 1
fi
echo "invariant check passed"
