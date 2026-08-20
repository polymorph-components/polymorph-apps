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
echo "[1/6] petname never crosses the frame seam"
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
echo "[2/6] chrome never renders the word \"password\""
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
echo "[3/6] the anchor colour is never made ambient"
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
echo "[4/6] chrome never exports a key"
echo "      (escrowed signing keys are non-extractable; nothing reads them back)"
exported=$(grep -n "exportKey" host/*.ts 2>/dev/null |
  grep -vE "^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)")
if [ -n "$exported" ]; then
  bad "exportKey appears in host code:"
  printf '%s\n' "$exported" | sed 's/^/       /'
else
  ok "no host/*.ts line calls exportKey"
fi

# --- (e) the user's identity never crosses the frame seam -------------------
# The user's own name, their word for this device and the glyph on
# chrome's button are rendered ONLY in chrome pixels. They are a second
# thing an impersonating rectangle cannot reproduce — but only for as
# long as a component cannot read them. A component that could would be
# able to greet the user by name from inside its own rectangle, which is
# precisely the impersonation the strip exists to make impossible; one
# that could INFLUENCE them would be putting attacker-chosen words into
# chrome's own voice on the anchor. So neither the storage key nor the
# cluster's id may appear anywhere on the seam.
echo "[5/6] the user's identity never crosses the frame seam"
echo "      (name, device and icon are chrome pixels; no component may read or steer them)"
idhits=$(grep -n "pm-demo-identity\|chrome-identity" \
  host/frame.ts host/frame-backend.ts web/frame.html 2>/dev/null)
if [ -n "$idhits" ]; then
  bad "the chrome identity record appears on the frame seam:"
  printf '%s\n' "$idhits" | sed 's/^/       /'
else
  ok "no identity reference in host/frame.ts, host/frame-backend.ts, web/frame.html"
fi

# --- (f) pairing code and SAS render only in chrome-owned surfaces --------
# PAIRING.md §5's new CI invariant: "the pairing code and SAS render
# only in chrome-owned surfaces, never inside a component frame". The
# grep-enforceable marker (chosen by Track B, per that section): both
# are rendered EXCLUSIVELY through two named functions,
# `renderPairingCode(` and `renderSas(`, defined once in
# host/pairing-chrome.ts (see that file's own comment at the
# definitions for the reasoning — pinning the RENDERING CALL SITE is a
# stronger property than grepping the word "SAS", which would also fire
# on comments). A component frame has no path to a host-side function
# call at all, so if either name ever appeared outside pairing-chrome.ts
# the architecture itself would have grown a new seam-crossing path.
echo "[6/6] pairing code and SAS render only in chrome-owned surfaces"
echo "      (renderPairingCode()/renderSas() are defined and called only in host/pairing-chrome.ts)"
outside=$(grep -rln "renderPairingCode(\|renderSas(" \
  host/frame.ts host/frame-backend.ts web/frame.html web/frame.js \
  guest-app guest-panel-s3 guest-panel-dropbox \
  2>/dev/null)
if [ -n "$outside" ]; then
  bad "renderPairingCode()/renderSas() referenced outside host/pairing-chrome.ts:"
  printf '%s\n' "$outside" | sed 's/^/       /'
else
  ok "no reference to renderPairingCode()/renderSas() outside host/pairing-chrome.ts"
fi
definers=$(grep -rl "^function renderPairingCode(\|^function renderSas(" host/*.ts 2>/dev/null | grep -v 'host/pairing-chrome.ts$')
if [ -n "$definers" ]; then
  bad "renderPairingCode()/renderSas() defined somewhere other than host/pairing-chrome.ts:"
  printf '%s\n' "$definers" | sed 's/^/       /'
else
  ok "renderPairingCode()/renderSas() are defined only in host/pairing-chrome.ts"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "invariant check FAILED — see above (#22 ruling table)"
  exit 1
fi
echo "invariant check passed"
