# Sourced by the Linux host entry points below. Rootful local Docker; fixed
# bind sources under a private parent, never paths relative to an operator's cwd.
set -euo pipefail
umask 077
export LC_ALL=C
shopt -s dotglob nullglob inherit_errexit
infra=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
state=/var/lib/lucent
backups=/var/backups/lucent
envfile=/etc/lucent/staging.env

die() { printf '%s\n' "$*" >&2; exit 1; }
(( EUID == 0 )) || die "Run as root on the staging host."

canonical() {
    [[ $(realpath -m -- "$1") == "$1" && ! -L $1 ]] || die "Unsafe path: $1"
}

compose() {
    # Shell variables (including COMPOSE_FILE and DOCKER_HOST) must not override
    # the reviewed stack or its operator-supplied environment.
    env -i PATH="$PATH" HOME=/root docker compose --env-file "$envfile" -f "$infra/compose.yml" "$@"
}

lock_host() {
    canonical "$state"
    [[ $(stat -c '%u:%g:%a' "$state") == 0:0:700 ]] || die "Provision this host first."
    exec 9<"$state"
    flock -n 9 || die "Another deployment, backup or restore holds the host lock."
    canonical "$envfile"
    [[ -f $envfile && $(stat -c '%u:%g:%a:%h' "$envfile") == 0:0:600:1 ]] ||
        die "Expected root-owned private staging.env."
    compose config --quiet
}

backup_path() {
    [[ $1 =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$ ]] || die "Expected a backup name, not a path."
    canonical "$backups/$1"
    [[ $(stat -c '%u:%g:%a' "$backups") == 0:0:700 ]] || die "Unsafe backup parent."
    printf '%s\n' "$backups/$1"
}

regular() {
    [[ -f $1 && ! -L $1 && $(stat -c %h -- "$1") == 1 ]] || die "Not a standalone regular file: $1"
}

artifact() {
    regular "$1"
    [[ ${1##*/} =~ ^[0-9a-f]{64}$ ]] || die "Invalid artifact name."
}

# A single seal covers the dump and the complete ordered set of immutable names;
# rehashing the bytes also catches a torn copy or an incorrect artifact name.
snapshot_digest() (
    cd -- "$1"
    regular db.dump
    [[ -d artifacts && ! -L artifacts ]] || die "Missing or unsafe artifacts directory."
    {
        sha256sum db.dump
        for file in artifacts/*; do
            artifact "$file"
            digest=$(b2sum -l 256 -- "$file")
            [[ ${digest%% *} == "${file##*/}" ]] || die "Incorrect artifact digest."
            printf '%s\n' "$file"
        done
    } | sha256sum | cut -d' ' -f1
)
