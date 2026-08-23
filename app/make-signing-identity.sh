#!/bin/bash
# Create a local code-signing identity, so rebuilding the app stops revoking Accessibility.
#
#   ./app/make-signing-identity.sh
#
# Why this exists
# ---------------
# macOS keys the Accessibility permission to an app's "designated requirement". For an
# ad-hoc signature that requirement is the cdhash:
#
#     designated => cdhash H"3abfe4f583557d03bb2033ae847c601392267bd8"
#
# The cdhash changes on every build, so every rebuild produced an app macOS considered a
# different program. The permission stayed in System Settings, ticked, pointing at a hash
# that no longer existed, which is why re-ticking the box did nothing and the entry had to be
# removed with `tccutil reset` before it could be granted again.
#
# Signing with a certificate makes the requirement the certificate identity instead, which is
# stable across builds. Grant once, rebuild freely.
#
# This is a self-signed certificate, so it does nothing for Gatekeeper: the app is still
# unidentified on other people's machines and still needs right-click → Open on first launch.
# It only fixes the rebuild loop for whoever builds from source.
#
# To remove it: Keychain Access → login → My Certificates → "My Day Local Signing" → Delete.

set -euo pipefail
NAME="${MYDAY_SIGN_ID:-My Day Local Signing}"

if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$NAME"; then
  echo "Already present: $NAME"
  security find-identity -v -p codesigning | grep -F "$NAME"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/cs.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $NAME
O  = local
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF

echo "Generating a self-signed code-signing certificate..."
openssl req -x509 -newkey rsa:2048 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -days 7300 -nodes -config "$TMP/cs.cnf" >/dev/null 2>&1
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -out "$TMP/bundle.p12" -name "$NAME" -passout pass:temp >/dev/null 2>&1

# -T /usr/bin/codesign lets codesign use the key without prompting on every build.
echo "Importing into your login keychain. macOS may ask for your password."
security import "$TMP/bundle.p12" -k "$HOME/Library/Keychains/login.keychain-db" \
  -P temp -T /usr/bin/codesign -A

echo
if security find-identity -v -p codesigning | grep -qF "$NAME"; then
  echo "Done. Now rebuild and grant Accessibility one more time:"
  echo
  echo "    tccutil reset Accessibility com.abhitsian.myday"
  echo "    ./app/build-app.sh && rm -rf '/Applications/My Day.app' \\"
  echo "      && cp -R 'app/build/My Day.app' /Applications/ && open '/Applications/My Day.app'"
  echo
  echo "Approve it once. Rebuilds after that keep the permission."
else
  echo "The certificate did not land in the keychain. Nothing else changed;"
  echo "build-app.sh will keep using ad-hoc signing."
  exit 1
fi
