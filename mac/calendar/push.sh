#!/usr/bin/env bash
# Takes the snapshot on stdin and makes it one ConfigMap in the cluster.
#
# A ConfigMap rather than an HTTP endpoint: the Mac already holds a kubeconfig
# that trusts the cluster's CA, so there is no token to rotate, no certificate to
# pin, and no inbound path into a namespace that has none. The bot reads the file
# the kubelet mounts.
set -euo pipefail

CONFIG=${ZY_CALENDAR_ENV:-$HOME/.config/zy-assistant/calendar.env}
# shellcheck source=/dev/null
[ -r "$CONFIG" ] && . "$CONFIG"

: "${KUBECONFIG_PATH:?set KUBECONFIG_PATH in $CONFIG}"
NAMESPACE=${CALENDAR_NAMESPACE:-zy-assistant}
CONFIGMAP=${CALENDAR_CONFIGMAP:-zy-calendar}
# launchd starts a job with a minimal PATH, so install.sh records where kubectl is
# rather than hoping the job's PATH has it.
KUBECTL=${KUBECTL:-kubectl}

tmp=$(mktemp -t zy-calendar)
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"

# The payload never reaches the log: only its size does.
size=$(wc -c < "$tmp" | tr -d ' ')
# Both calls take the kubeconfig: the create is client-side only, but left to find
# its own config it would read whatever the user's default one happens to be.
"$KUBECTL" create configmap "$CONFIGMAP" --from-file=snapshot.json="$tmp" \
  --namespace "$NAMESPACE" --dry-run=client -o yaml --kubeconfig "$KUBECONFIG_PATH" \
  | "$KUBECTL" apply --server-side --force-conflicts --field-manager=zy-calendar-export \
      --request-timeout=20s --namespace "$NAMESPACE" -f - \
      --kubeconfig "$KUBECONFIG_PATH" > /dev/null
# Timestamped, because this log is the only record of whether a 07:30 or 18:30
# launchd run happened: without it a missed slot is invisible and has to be
# inferred from the ConfigMap's generatedAt.
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) pushed: $size bytes"
