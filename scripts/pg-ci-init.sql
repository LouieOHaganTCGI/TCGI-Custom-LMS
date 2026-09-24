-- CI-only database roles, mirroring scripts/pg-local.sh (ADR-0004: separate owner and non-owner NOBYPASSRLS app role).
CREATE ROLE lms_owner LOGIN PASSWORD 'lms_owner_local' NOBYPASSRLS;
CREATE ROLE lms_app LOGIN PASSWORD 'lms_app_local' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE lms_test OWNER lms_owner;
CREATE DATABASE lms_e2e OWNER lms_owner;
