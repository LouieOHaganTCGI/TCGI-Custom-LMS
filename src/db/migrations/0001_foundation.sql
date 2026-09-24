-- 0001 foundation: identity, tenancy, content, entitlement, enrolment, SCORM progress, outbox, audit.
-- Runs as the owner role (lms_owner). The application connects as lms_app, which is not the owner
-- and has NOBYPASSRLS, so the row-level security below always applies to it (ADR-0004, threat T-15).
-- Data model reference: docs/03-data-model-and-threat-model.md

-- The application role name is fixed as lms_app, and deployments must create it (see scripts/pg-local.sh).
GRANT USAGE ON SCHEMA public TO lms_app;

-- ---------------------------------------------------------------------------------------------
-- Request context used by RLS policies. Set per transaction by src/db/scoped.ts via set_config(..., true).
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app_person_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.person_id', true), '')::uuid $$;

CREATE FUNCTION app_managed_org_ids() RETURNS uuid[] LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('app.managed_org_ids', true), '')::uuid[], '{}'::uuid[]) $$;

CREATE FUNCTION app_is_platform() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('app.platform', true), '')::boolean, false) $$;

-- Generic guard used by append-only / immutable tables.
CREATE FUNCTION reject_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted (append-only or immutable record)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- ---------------------------------------------------------------------------------------------
-- Organisations and people
-- ---------------------------------------------------------------------------------------------
CREATE TABLE organisation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,64}$'),
  kind        text NOT NULL CHECK (kind IN ('tcgi_direct', 'enterprise')),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- Exactly one TCGI Direct organisation holds the B2C licensing context.
CREATE UNIQUE INDEX organisation_one_tcgi_direct ON organisation ((kind)) WHERE kind = 'tcgi_direct';

CREATE TABLE person (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name    text NOT NULL,
  primary_email   text,              -- mutable attribute, never an identity key (ID-01)
  email_verified  boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deactivated')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity_link (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id      uuid NOT NULL REFERENCES person(id),
  issuer         text NOT NULL,
  subject        text NOT NULL,
  linked_via     text NOT NULL CHECK (linked_via IN ('provisioning', 'invitation', 'migration', 'self_registration', 'support')),
  linked_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz,
  UNIQUE (issuer, subject)
);
CREATE INDEX identity_link_person ON identity_link (person_id);

CREATE TABLE organisation_membership (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  person_id        uuid NOT NULL REFERENCES person(id),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  source           text NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  UNIQUE (organisation_id, person_id)
);
CREATE INDEX organisation_membership_person ON organisation_membership (person_id);

CREATE TABLE role_grant (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id        uuid NOT NULL REFERENCES person(id),
  role             text NOT NULL CHECK (role IN ('tcgi_admin', 'enterprise_manager')),
  scope_type       text NOT NULL CHECK (scope_type IN ('platform', 'organisation')),
  organisation_id  uuid REFERENCES organisation(id),
  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_to         timestamptz,
  granted_by       uuid REFERENCES person(id),
  reason           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_type = 'platform' AND organisation_id IS NULL) OR (scope_type = 'organisation' AND organisation_id IS NOT NULL)),
  CHECK ((role = 'tcgi_admin' AND scope_type = 'platform') OR (role = 'enterprise_manager' AND scope_type = 'organisation'))
);
CREATE INDEX role_grant_person ON role_grant (person_id);

-- ---------------------------------------------------------------------------------------------
-- Web sessions and OIDC login requests (system tables; only reached through the system context)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE web_session (
  id_hash              text PRIMARY KEY,           -- sha256 of the cookie value; the raw id is never stored
  person_id            uuid NOT NULL REFERENCES person(id),
  csrf_token           text NOT NULL,
  identity_link_id     uuid NOT NULL REFERENCES identity_link(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  idle_expires_at      timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  revoked_at           timestamptz
);
CREATE INDEX web_session_person ON web_session (person_id);

CREATE TABLE auth_request (
  id             text PRIMARY KEY,                 -- sha256 of the cookie value
  state          text NOT NULL,
  nonce          text NOT NULL,
  code_verifier  text NOT NULL,
  return_to      text NOT NULL,
  expires_at     timestamptz NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Content: ContentItem (reusable identity) / ContentVersion (immutable build) / Course / CourseRevision
-- / CoursePlacement (CAT-02, CAT-05)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE content_item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stable_key  text NOT NULL UNIQUE CHECK (stable_key ~ '^[a-z0-9][a-z0-9._-]{1,127}$'),
  title       text NOT NULL,
  created_by  uuid REFERENCES person(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content_version (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id      uuid NOT NULL REFERENCES content_item(id),
  version_no           integer NOT NULL CHECK (version_no > 0),
  package_sha256       text NOT NULL UNIQUE CHECK (package_sha256 ~ '^[0-9a-f]{64}$'),
  scorm_version        text NOT NULL CHECK (scorm_version IN ('1.2', '2004')),
  scorm_edition        text,
  manifest_identifier  text NOT NULL,
  title                text NOT NULL,
  launch_href          text NOT NULL,
  file_count           integer NOT NULL,
  total_bytes          bigint NOT NULL,
  runtime_provider     text NOT NULL DEFAULT 'scorm-again',
  status               text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'retired')),
  created_by           uuid REFERENCES person(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_item_id, version_no),
  UNIQUE (id, content_item_id)
);

-- A content version is immutable. Only the status may change (retirement), and rows are never deleted.
CREATE FUNCTION content_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'content_version rows cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'content_version is immutable; upload a new version instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER content_version_immutable BEFORE UPDATE OR DELETE ON content_version
  FOR EACH ROW EXECUTE FUNCTION content_version_guard();

CREATE TABLE course (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,96}$'),
  title       text NOT NULL,
  -- Product tiers from brief CAT-03 / spec §3.2.
  tier        text NOT NULL CHECK (tier IN ('microlesson', 'foundation', 'professional_certificate', 'advanced_certificate', 'diploma')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE course_revision (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id            uuid NOT NULL REFERENCES course(id),
  revision_no          integer NOT NULL CHECK (revision_no > 0),
  state                text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'retired')),
  completion_rule_ref  text NOT NULL,
  published_at         timestamptz,
  published_by         uuid REFERENCES person(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, revision_no),
  UNIQUE (id, course_id)
);

CREATE FUNCTION course_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'course_revision rows cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.state <> 'draft' THEN
    -- Published revisions are immutable except for retirement.
    IF NOT (OLD.state = 'published' AND NEW.state = 'retired'
            AND (to_jsonb(NEW) - 'state') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'state')) THEN
      RAISE EXCEPTION 'published course revisions are immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER course_revision_immutable BEFORE UPDATE OR DELETE ON course_revision
  FOR EACH ROW EXECUTE FUNCTION course_revision_guard();

CREATE TABLE course_placement (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_revision_id  uuid NOT NULL REFERENCES course_revision(id),
  content_item_id     uuid NOT NULL,
  content_version_id  uuid NOT NULL,
  position            integer NOT NULL CHECK (position > 0),
  title               text NOT NULL,
  required            boolean NOT NULL DEFAULT true,
  UNIQUE (course_revision_id, position),
  UNIQUE (course_revision_id, content_item_id),
  -- The pinned version must belong to the placed content item.
  FOREIGN KEY (content_version_id, content_item_id) REFERENCES content_version (id, content_item_id)
);

-- Placements of a non-draft revision cannot change.
CREATE FUNCTION course_placement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rev_state text;
BEGIN
  SELECT state INTO rev_state FROM course_revision
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.course_revision_id ELSE NEW.course_revision_id END;
  IF rev_state <> 'draft' THEN
    RAISE EXCEPTION 'placements of a published revision are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER course_placement_immutable BEFORE INSERT OR UPDATE OR DELETE ON course_placement
  FOR EACH ROW EXECUTE FUNCTION course_placement_guard();

-- Commerce product -> course mapping. The commerce system owns price; nothing about price is stored here.
CREATE TABLE commercial_product_reference (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source               text NOT NULL,
  external_product_id  text NOT NULL,
  course_id            uuid NOT NULL REFERENCES course(id),
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_product_id)
);

-- ---------------------------------------------------------------------------------------------
-- Entitlement (access decision), kept separate from purchase proof and from enrolment
-- ---------------------------------------------------------------------------------------------
CREATE TABLE entitlement (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL REFERENCES organisation(id),
  person_id           uuid NOT NULL REFERENCES person(id),
  course_id           uuid NOT NULL REFERENCES course(id),
  grant_type          text NOT NULL CHECK (grant_type IN ('commerce_line', 'seat', 'manual')),
  source              text NOT NULL,
  external_order_id   text NOT NULL,
  external_line_id    text NOT NULL,
  product_ref_id      uuid REFERENCES commercial_product_reference(id),
  status              text NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'revoked', 'expired')),
  valid_from          timestamptz NOT NULL,
  valid_until         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_order_id, external_line_id),
  UNIQUE (id, organisation_id)
);
CREATE INDEX entitlement_person ON entitlement (person_id);

CREATE TABLE entitlement_decision (
  id               bigserial PRIMARY KEY,
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  entitlement_id   uuid NOT NULL REFERENCES entitlement(id),
  input_ref        jsonb NOT NULL,
  rule_version     text NOT NULL,
  before           jsonb,
  after            jsonb NOT NULL,
  decided_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER entitlement_decision_append_only BEFORE UPDATE OR DELETE ON entitlement_decision
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---------------------------------------------------------------------------------------------
-- Enrolment, Attempt, raw RuntimeCommit, derived ProgressState (LRN-01)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE enrolment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id      uuid NOT NULL REFERENCES organisation(id),
  person_id            uuid NOT NULL REFERENCES person(id),
  course_id            uuid NOT NULL REFERENCES course(id),
  course_revision_id   uuid NOT NULL,
  entitlement_id       uuid NOT NULL,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired', 'withdrawn')),
  access_start         timestamptz NOT NULL,
  access_end           timestamptz,
  completion_rule_ref  text NOT NULL,
  enrolled_at          timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  FOREIGN KEY (course_revision_id, course_id) REFERENCES course_revision (id, course_id),
  -- The justifying entitlement must be in the same licensing context (organisation).
  FOREIGN KEY (entitlement_id, organisation_id) REFERENCES entitlement (id, organisation_id),
  UNIQUE (id, organisation_id)
);
CREATE UNIQUE INDEX enrolment_one_live_per_course ON enrolment (person_id, course_id, organisation_id)
  WHERE status IN ('active', 'completed');
CREATE INDEX enrolment_org ON enrolment (organisation_id);

CREATE TABLE attempt (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     uuid NOT NULL,
  enrolment_id        uuid NOT NULL,
  person_id           uuid NOT NULL REFERENCES person(id),
  placement_id        uuid NOT NULL REFERENCES course_placement(id),
  content_version_id  uuid NOT NULL REFERENCES content_version(id),
  attempt_no          integer NOT NULL CHECK (attempt_no > 0),
  runtime_provider    text NOT NULL,
  started_at          timestamptz NOT NULL DEFAULT now(),
  last_commit_at      timestamptz,
  ended_at            timestamptz,
  FOREIGN KEY (enrolment_id, organisation_id) REFERENCES enrolment (id, organisation_id),
  UNIQUE (enrolment_id, placement_id, attempt_no)
);

CREATE TABLE launch_code (
  code_hash   text PRIMARY KEY,
  attempt_id  uuid NOT NULL REFERENCES attempt(id),
  person_id   uuid NOT NULL REFERENCES person(id),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

-- Raw evidence: every commit is stored exactly as received, append-only.
CREATE TABLE runtime_commit (
  id               bigserial PRIMARY KEY,
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  attempt_id       uuid NOT NULL REFERENCES attempt(id),
  person_id        uuid NOT NULL REFERENCES person(id),
  seq              integer NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  payload          jsonb NOT NULL,
  payload_sha256   text NOT NULL,
  terminate        boolean NOT NULL DEFAULT false,
  UNIQUE (attempt_id, seq)
);
CREATE TRIGGER runtime_commit_append_only BEFORE UPDATE OR DELETE ON runtime_commit
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- Derived, rebuildable from runtime_commit. The values are learner-reported (threat T-11).
CREATE TABLE progress_state (
  attempt_id          uuid PRIMARY KEY REFERENCES attempt(id),
  organisation_id     uuid NOT NULL REFERENCES organisation(id),
  person_id           uuid NOT NULL REFERENCES person(id),
  completion_status   text NOT NULL DEFAULT 'not_attempted' CHECK (completion_status IN ('not_attempted', 'incomplete', 'completed', 'unknown')),
  success_status      text NOT NULL DEFAULT 'unknown' CHECK (success_status IN ('passed', 'failed', 'unknown')),
  score_raw           numeric,
  score_min           numeric,
  score_max           numeric,
  score_scaled        numeric,
  location            text,
  suspend_data        text,
  exit_mode           text,
  total_time          text,
  first_completed_at  timestamptz,        -- never cleared once set: history is not erased
  last_commit_seq     integer NOT NULL DEFAULT 0,
  source              text NOT NULL DEFAULT 'client_reported' CHECK (source IN ('client_reported', 'migrated')),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- Integration outbox (ADR-0006) and delivery attempts
-- ---------------------------------------------------------------------------------------------
CREATE TABLE outbox_message (
  seq              bigserial UNIQUE,          -- global order; per-aggregate order is derived from it
  id               uuid PRIMARY KEY,          -- the event id (also the idempotency key)
  destination      text NOT NULL,
  event_type       text NOT NULL,
  aggregate_type   text NOT NULL,
  aggregate_id     text NOT NULL,
  payload          jsonb NOT NULL,            -- the full contract envelope (docs/contracts)
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz
);
CREATE INDEX outbox_pending ON outbox_message (next_attempt_at) WHERE status = 'pending';
CREATE INDEX outbox_aggregate ON outbox_message (destination, aggregate_type, aggregate_id, seq);

CREATE TABLE delivery_attempt (
  id                bigserial PRIMARY KEY,
  outbox_id         uuid NOT NULL REFERENCES outbox_message(id),
  attempted_at      timestamptz NOT NULL DEFAULT now(),
  http_status       integer,
  outcome           text NOT NULL CHECK (outcome IN ('delivered', 'retry', 'dead')),
  error             text,
  duration_ms       integer NOT NULL
);
CREATE TRIGGER delivery_attempt_append_only BEFORE UPDATE OR DELETE ON delivery_attempt
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---------------------------------------------------------------------------------------------
-- Audit trail: append-only, hash-chained for tamper evidence (OPS-03, threat T-17)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE audit_entry (
  id               bigserial PRIMARY KEY,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  actor_type       text NOT NULL CHECK (actor_type IN ('person', 'system', 'service')),
  actor_person_id  uuid REFERENCES person(id),
  actor_label      text NOT NULL,
  organisation_id  uuid REFERENCES organisation(id),
  action           text NOT NULL,
  entity_type      text NOT NULL,
  entity_id        text NOT NULL,
  before           jsonb,
  after            jsonb,
  reason           text,
  request_id       text,
  prev_hash        text NOT NULL,
  entry_hash       text NOT NULL
);
CREATE INDEX audit_entity ON audit_entry (entity_type, entity_id);
CREATE INDEX audit_org ON audit_entry (organisation_id, id);

-- SECURITY DEFINER so the chain head is read regardless of the caller's RLS visibility. The advisory
-- lock serialises audit writers so the chain is linear.
CREATE FUNCTION audit_entry_chain() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_entry_chain'));
  SELECT entry_hash INTO last_hash FROM audit_entry ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := coalesce(last_hash, repeat('0', 64));
  NEW.occurred_at := now();
  NEW.entry_hash := encode(sha256(convert_to(
      NEW.prev_hash || '|' || NEW.occurred_at::text || '|' || NEW.actor_type || '|' || coalesce(NEW.actor_person_id::text, '') || '|' ||
      coalesce(NEW.organisation_id::text, '') || '|' || NEW.action || '|' || NEW.entity_type || '|' || NEW.entity_id || '|' ||
      coalesce(NEW.before::text, '') || '|' || coalesce(NEW.after::text, '') || '|' || coalesce(NEW.reason, ''), 'UTF8')), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER audit_entry_chain BEFORE INSERT ON audit_entry FOR EACH ROW EXECUTE FUNCTION audit_entry_chain();
CREATE TRIGGER audit_entry_append_only BEFORE UPDATE OR DELETE ON audit_entry
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---------------------------------------------------------------------------------------------
-- Row-level security (ADR-0004). "platform" is set only for TCGI platform roles and named system tasks.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE organisation ENABLE ROW LEVEL SECURITY;
CREATE POLICY organisation_read ON organisation FOR SELECT USING (
  app_is_platform() OR id = ANY (app_managed_org_ids())
  OR EXISTS (SELECT 1 FROM organisation_membership m WHERE m.organisation_id = organisation.id AND m.person_id = app_person_id()));
CREATE POLICY organisation_write ON organisation FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());

ALTER TABLE person ENABLE ROW LEVEL SECURITY;
CREATE POLICY person_read ON person FOR SELECT USING (
  app_is_platform() OR id = app_person_id()
  OR EXISTS (SELECT 1 FROM organisation_membership m WHERE m.person_id = person.id AND m.organisation_id = ANY (app_managed_org_ids())));
CREATE POLICY person_write ON person FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());

ALTER TABLE identity_link ENABLE ROW LEVEL SECURITY;
CREATE POLICY identity_link_read ON identity_link FOR SELECT USING (app_is_platform() OR person_id = app_person_id());
CREATE POLICY identity_link_write ON identity_link FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());

ALTER TABLE organisation_membership ENABLE ROW LEVEL SECURITY;
CREATE POLICY membership_read ON organisation_membership FOR SELECT USING (
  app_is_platform() OR person_id = app_person_id() OR organisation_id = ANY (app_managed_org_ids()));
CREATE POLICY membership_write ON organisation_membership FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());

ALTER TABLE role_grant ENABLE ROW LEVEL SECURITY;
CREATE POLICY role_grant_read ON role_grant FOR SELECT USING (
  app_is_platform() OR person_id = app_person_id() OR organisation_id = ANY (app_managed_org_ids()));
CREATE POLICY role_grant_write ON role_grant FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());

ALTER TABLE web_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY web_session_system ON web_session FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());
ALTER TABLE auth_request ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_request_system ON auth_request FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());
ALTER TABLE launch_code ENABLE ROW LEVEL SECURITY;
CREATE POLICY launch_code_owner ON launch_code FOR ALL USING (app_is_platform() OR person_id = app_person_id())
  WITH CHECK (app_is_platform() OR person_id = app_person_id());

-- TCGI-owned global catalogue: readable by any signed-in principal, and written only by platform.
ALTER TABLE content_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY content_item_read ON content_item FOR SELECT USING (app_is_platform() OR app_person_id() IS NOT NULL);
CREATE POLICY content_item_write ON content_item FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());
ALTER TABLE content_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY content_version_read ON content_version FOR SELECT USING (app_is_platform() OR app_person_id() IS NOT NULL);
CREATE POLICY content_version_write ON content_version FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());
ALTER TABLE course ENABLE ROW LEVEL SECURITY;
CREATE POLICY course_read ON course FOR SELECT USING (app_is_platform() OR app_person_id() IS NOT NULL);
CREATE POLICY course_write ON course FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());
ALTER TABLE course_revision ENABLE ROW LEVEL SECURITY;
CREATE POLICY course_revision_read ON course_revision FOR SELECT USING (app_is_platform() OR app_person_id() IS NOT NULL);
CREATE POLICY course_revision_write ON course_revision FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());
ALTER TABLE course_placement ENABLE ROW LEVEL SECURITY;
CREATE POLICY course_placement_read ON course_placement FOR SELECT USING (app_is_platform() OR app_person_id() IS NOT NULL);
CREATE POLICY course_placement_write ON course_placement FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());
ALTER TABLE commercial_product_reference ENABLE ROW LEVEL SECURITY;
CREATE POLICY product_ref_system ON commercial_product_reference FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());

-- Tenant-scoped learning records: visible to the person, managers of the licensing org, and platform.
ALTER TABLE entitlement ENABLE ROW LEVEL SECURITY;
CREATE POLICY entitlement_read ON entitlement FOR SELECT USING (
  app_is_platform() OR person_id = app_person_id() OR organisation_id = ANY (app_managed_org_ids()));
CREATE POLICY entitlement_write ON entitlement FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());
ALTER TABLE entitlement_decision ENABLE ROW LEVEL SECURITY;
CREATE POLICY entitlement_decision_read ON entitlement_decision FOR SELECT USING (app_is_platform() OR organisation_id = ANY (app_managed_org_ids()));
CREATE POLICY entitlement_decision_write ON entitlement_decision FOR INSERT WITH CHECK (app_is_platform());

ALTER TABLE enrolment ENABLE ROW LEVEL SECURITY;
CREATE POLICY enrolment_read ON enrolment FOR SELECT USING (
  app_is_platform() OR person_id = app_person_id() OR organisation_id = ANY (app_managed_org_ids()));
CREATE POLICY enrolment_insert ON enrolment FOR INSERT WITH CHECK (app_is_platform() OR person_id = app_person_id());
CREATE POLICY enrolment_update ON enrolment FOR UPDATE USING (app_is_platform() OR person_id = app_person_id())
  WITH CHECK (app_is_platform() OR person_id = app_person_id());

ALTER TABLE attempt ENABLE ROW LEVEL SECURITY;
CREATE POLICY attempt_read ON attempt FOR SELECT USING (
  app_is_platform() OR person_id = app_person_id() OR organisation_id = ANY (app_managed_org_ids()));
CREATE POLICY attempt_insert ON attempt FOR INSERT WITH CHECK (app_is_platform() OR person_id = app_person_id());
CREATE POLICY attempt_update ON attempt FOR UPDATE USING (app_is_platform() OR person_id = app_person_id())
  WITH CHECK (app_is_platform() OR person_id = app_person_id());

ALTER TABLE runtime_commit ENABLE ROW LEVEL SECURITY;
CREATE POLICY runtime_commit_read ON runtime_commit FOR SELECT USING (
  app_is_platform() OR person_id = app_person_id() OR organisation_id = ANY (app_managed_org_ids()));
CREATE POLICY runtime_commit_insert ON runtime_commit FOR INSERT WITH CHECK (person_id = app_person_id());

ALTER TABLE progress_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY progress_read ON progress_state FOR SELECT USING (
  app_is_platform() OR person_id = app_person_id() OR organisation_id = ANY (app_managed_org_ids()));
CREATE POLICY progress_insert ON progress_state FOR INSERT WITH CHECK (person_id = app_person_id());
CREATE POLICY progress_update ON progress_state FOR UPDATE USING (person_id = app_person_id()) WITH CHECK (person_id = app_person_id());

-- Any domain transaction may enqueue. Only the platform (dispatcher, admin) may read or change the queue.
ALTER TABLE outbox_message ENABLE ROW LEVEL SECURITY;
CREATE POLICY outbox_enqueue ON outbox_message FOR INSERT WITH CHECK (true);
CREATE POLICY outbox_platform_read ON outbox_message FOR SELECT USING (app_is_platform());
CREATE POLICY outbox_platform_update ON outbox_message FOR UPDATE USING (app_is_platform()) WITH CHECK (app_is_platform());
ALTER TABLE delivery_attempt ENABLE ROW LEVEL SECURITY;
CREATE POLICY delivery_attempt_platform ON delivery_attempt FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());

ALTER TABLE audit_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_append ON audit_entry FOR INSERT WITH CHECK (true);
CREATE POLICY audit_read ON audit_entry FOR SELECT USING (app_is_platform() OR organisation_id = ANY (app_managed_org_ids()));

-- ---------------------------------------------------------------------------------------------
-- Grants for the application role. Deliberately no DELETE or TRUNCATE on anything, and no UPDATE on
-- append-only tables.
-- ---------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON organisation, person, identity_link, organisation_membership, role_grant,
  web_session, auth_request, launch_code, content_item, content_version, course, course_revision,
  commercial_product_reference, entitlement, enrolment, attempt, progress_state, outbox_message TO lms_app;
GRANT SELECT, INSERT ON course_placement, entitlement_decision, runtime_commit, delivery_attempt, audit_entry TO lms_app;
GRANT DELETE ON auth_request TO lms_app;   -- single-use login requests are consumed
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO lms_app;
GRANT EXECUTE ON FUNCTION app_person_id(), app_managed_org_ids(), app_is_platform() TO lms_app;
