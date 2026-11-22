#!/usr/bin/env bash
# As root: bash infra/ops/provision.sh on a clean Linux host with local rootful
# Docker Engine and Compose v2 (--wait). No package install or service start.
# Fill the first section of /etc/lucent/staging.env from the operator's secret
# store; retain these exact keys separately for disaster recovery. Configure
# DNS for both origins and allow inbound 80/tcp and 443/tcp+udp before deploy.
source "$(dirname -- "$0")/common.sh"
docker info >/dev/null
docker compose version >/dev/null

directory() {
    local path=$1 uid=$2 gid=$3 mode=$4
    canonical "$path"
    if [[ ! -e $path ]]; then
        install -d -o "$uid" -g "$gid" -m "$mode" -- "$path"
    fi
    [[ -d $path && $(stat -c '%u:%g:%a' "$path") == "$uid:$gid:$mode" ]] ||
        die "Unexpected existing directory or ownership: $path"
}

directory /etc/lucent 0 0 700
directory "$backups" 0 0 700
directory "$state" 0 0 700
directory "$state/postgres" 999 999 700
directory "$state/db-socket" 999 999 750
directory "$state/artifacts" 21001 21100 700
# Directory group grants traversal only to the intended reader; the socket
# inode's group (21100) grants connect, not unlink. Readers also mount :ro.
directory "$state/internal-socket" 21001 21002 750
directory "$state/native-socket" 21001 21003 750
directory "$state/web-socket" 21002 21003 750
directory "$state/caddy-data" 21003 21003 700
directory "$state/caddy-config" 21003 21003 700
canonical "$envfile"
if [[ ! -e $envfile ]]; then
    install -m 600 "$infra/ops/env.example" "$envfile"
fi
[[ -f $envfile && $(stat -c '%u:%g:%a:%h' "$envfile") == 0:0:600:1 ]] ||
    die "Unsafe existing staging.env."
