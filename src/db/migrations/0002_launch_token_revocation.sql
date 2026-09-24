-- 0002: sign-out and deactivation revoke content-origin launch tokens issued before that moment.
-- Tokens carry an issued-at time (iat). A token is accepted only if iat >= launch_tokens_valid_after.
ALTER TABLE person ADD COLUMN launch_tokens_valid_after timestamptz;
