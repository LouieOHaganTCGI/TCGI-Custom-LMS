#!/usr/bin/env bash
# Start a throwaway local PostgreSQL 16 cluster for development and tests.
# Creates two roles, per ADR-0004:
#   lms_owner - owns the schema, runs migrations
#   lms_app   - the application role: NOT owner, NOBYPASSRLS, so row-level security always applies
# Local development only. Passwords are fixed local-dev values, never used anywhere else.
set -euo pipefail
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
DATA="${PGDATA_DIR:-$(pwd)/.pgdata}"
PORT="${PGPORT:-54329}"
# PostgreSQL refuses to run as root. In root containers, run the server as the 'postgres' OS user.
AS=()
if [ "$(id -u)" = "0" ]; then AS=(runuser -u postgres --); mkdir -p "$DATA"; chown postgres "$DATA"; chmod 700 "$DATA"; fi
if [ ! -f "$DATA/PG_VERSION" ]; then
  "${AS[@]}" "$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
  printf "listen_addresses='127.0.0.1'\nport=%s\nunix_socket_directories='%s'\n" "$PORT" "$DATA" | "${AS[@]}" tee -a "$DATA/postgresql.conf" >/dev/null
fi
if ! "${AS[@]}" "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
  "${AS[@]}" "$PGBIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w start >/dev/null
fi
psql() { command psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
for db in lms_dev lms_test lms_e2e; do
  psql -c "SELECT 1 FROM pg_roles WHERE rolname='lms_owner'" | grep -q 1 || psql -c "CREATE ROLE lms_owner LOGIN PASSWORD 'lms_owner_local' NOBYPASSRLS"
  psql -c "SELECT 1 FROM pg_roles WHERE rolname='lms_app'" | grep -q 1 || psql -c "CREATE ROLE lms_app LOGIN PASSWORD 'lms_app_local' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE"
  psql -c "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || psql -c "CREATE DATABASE $db OWNER lms_owner"
  psql -d "$db" -c "REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO lms_app"
done
echo "PostgreSQL running on 127.0.0.1:$PORT (databases: lms_dev, lms_test, lms_e2e)"
