-- 0003: S4 inbound entitlement events · S5 enterprise agreements, seats and invitations · CPD awards.
-- Rules marked PROVISIONAL follow docs/00 and docs/07 safe defaults until the named decision is made.

-- ---------------------------------------------------------------------------------------------
-- S4: durable inbox of signed commerce events (docs/04 §1–2, ADR-0006)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE integration_event (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source           text NOT NULL,
  idempotency_key  text NOT NULL,
  envelope_id      uuid NOT NULL,
  event_type       text NOT NULL,
  schema_version   text NOT NULL,
  aggregate_id     text NOT NULL,                  -- "<order>:<line>"
  effective_at     timestamptz NOT NULL,
  source_sequence  bigint,
  payload          jsonb NOT NULL,
  payload_sha256   text NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'held')),
  status_reason    text,
  processed_at     timestamptz,
  entitlement_id   uuid REFERENCES entitlement(id),
  UNIQUE (source, idempotency_key)
);
CREATE INDEX integration_event_aggregate ON integration_event (source, aggregate_id);
CREATE INDEX integration_event_pending ON integration_event (received_at) WHERE status = 'received';

-- The evidence (payload and identity) is immutable. Only processing fields may change.
CREATE FUNCTION integration_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'integration_event rows cannot be deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status','status_reason','processed_at','entitlement_id']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','status_reason','processed_at','entitlement_id']) THEN
    RAISE EXCEPTION 'integration_event evidence is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_event_immutable BEFORE UPDATE OR DELETE ON integration_event FOR EACH ROW EXECUTE FUNCTION integration_event_guard();

ALTER TABLE integration_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY integration_event_platform ON integration_event FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());
GRANT SELECT, INSERT, UPDATE ON integration_event TO lms_app;

-- ---------------------------------------------------------------------------------------------
-- S5: enterprise agreements, allowed catalogue, seats, invitations (ENT-01, ENT-02, ID-03)
-- The values (seat limits, dates, courses) come from contracts (DEC-12). None are invented here.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE agreement (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  reference        text NOT NULL,
  seat_limit       integer NOT NULL CHECK (seat_limit > 0),
  access_start     timestamptz NOT NULL,
  access_end       timestamptz NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_by       uuid REFERENCES person(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (access_end > access_start),
  UNIQUE (organisation_id, reference),
  UNIQUE (id, organisation_id)
);

CREATE TABLE agreement_course (
  agreement_id  uuid NOT NULL REFERENCES agreement(id),
  course_id     uuid NOT NULL REFERENCES course(id),
  PRIMARY KEY (agreement_id, course_id)
);

CREATE TABLE seat_allocation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL,
  agreement_id     uuid NOT NULL,
  person_id        uuid NOT NULL REFERENCES person(id),
  state            text NOT NULL DEFAULT 'allocated' CHECK (state IN ('allocated', 'released')),
  allocated_by     uuid REFERENCES person(id),
  allocated_at     timestamptz NOT NULL DEFAULT now(),
  released_by      uuid REFERENCES person(id),
  released_at      timestamptz,
  release_reason   text,
  FOREIGN KEY (agreement_id, organisation_id) REFERENCES agreement (id, organisation_id)
);
CREATE UNIQUE INDEX seat_one_active_per_person ON seat_allocation (agreement_id, person_id) WHERE state = 'allocated';

ALTER TABLE organisation_membership DROP CONSTRAINT organisation_membership_status_check;
ALTER TABLE organisation_membership ADD CONSTRAINT organisation_membership_status_check CHECK (status IN ('invited', 'active', 'ended'));

CREATE TABLE invitation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  person_id        uuid NOT NULL REFERENCES person(id),
  token_hash       text NOT NULL UNIQUE,
  invited_by       uuid REFERENCES person(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  revoked_at       timestamptz
);

ALTER TABLE auth_request ADD COLUMN invite_token_hash text;

ALTER TABLE agreement ENABLE ROW LEVEL SECURITY;
CREATE POLICY agreement_read ON agreement FOR SELECT USING (app_is_platform() OR organisation_id = ANY (app_managed_org_ids()));
CREATE POLICY agreement_write ON agreement FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());
-- Managers lock their agreement row (FOR UPDATE) to enforce the seat limit under concurrency.
CREATE POLICY agreement_lock ON agreement FOR UPDATE USING (organisation_id = ANY (app_managed_org_ids())) WITH CHECK (false);

ALTER TABLE agreement_course ENABLE ROW LEVEL SECURITY;
CREATE POLICY agreement_course_read ON agreement_course FOR SELECT USING (app_is_platform()
  OR EXISTS (SELECT 1 FROM agreement a WHERE a.id = agreement_course.agreement_id AND a.organisation_id = ANY (app_managed_org_ids())));
CREATE POLICY agreement_course_write ON agreement_course FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform());

ALTER TABLE seat_allocation ENABLE ROW LEVEL SECURITY;
CREATE POLICY seat_read ON seat_allocation FOR SELECT USING (app_is_platform() OR person_id = app_person_id() OR organisation_id = ANY (app_managed_org_ids()));
CREATE POLICY seat_insert ON seat_allocation FOR INSERT WITH CHECK (app_is_platform() OR organisation_id = ANY (app_managed_org_ids()));
-- PROVISIONAL (DEC-32): only TCGI releases or reassigns seats until the contract rules are known.
CREATE POLICY seat_update ON seat_allocation FOR UPDATE USING (app_is_platform()) WITH CHECK (app_is_platform());

ALTER TABLE invitation ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitation_read ON invitation FOR SELECT USING (app_is_platform() OR organisation_id = ANY (app_managed_org_ids()));
CREATE POLICY invitation_write ON invitation FOR UPDATE USING (app_is_platform()) WITH CHECK (app_is_platform());

GRANT SELECT, INSERT, UPDATE ON agreement, seat_allocation, invitation TO lms_app;
GRANT SELECT, INSERT ON agreement_course TO lms_app;

-- Managers may write seat-based entitlements (and their decision records) only for organisations they manage.
DROP POLICY entitlement_write ON entitlement;
CREATE POLICY entitlement_write ON entitlement FOR ALL USING (app_is_platform() OR (grant_type = 'seat' AND organisation_id = ANY (app_managed_org_ids())))
  WITH CHECK (app_is_platform() OR (grant_type = 'seat' AND organisation_id = ANY (app_managed_org_ids())));
DROP POLICY entitlement_decision_write ON entitlement_decision;
CREATE POLICY entitlement_decision_write ON entitlement_decision FOR INSERT WITH CHECK (app_is_platform() OR organisation_id = ANY (app_managed_org_ids()));

-- Invite a person into an organisation. SECURITY DEFINER so a manager can create the (org-less) person
-- row, but the function itself enforces that the caller manages that organisation (or is platform).
CREATE FUNCTION invite_person(p_org uuid, p_name text, p_email text, p_token_hash text, p_expires timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE pid uuid;
BEGIN
  IF NOT (app_is_platform() OR p_org = ANY (app_managed_org_ids())) THEN
    RAISE EXCEPTION 'not permitted to invite into this organisation' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (SELECT kind FROM organisation WHERE id = p_org) IS DISTINCT FROM 'enterprise' THEN
    RAISE EXCEPTION 'invitations are only for enterprise organisations' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO person (display_name, primary_email, email_verified, updated_at) VALUES (p_name, p_email, false, now()) RETURNING id INTO pid;
  INSERT INTO organisation_membership (organisation_id, person_id, status, source) VALUES (p_org, pid, 'invited', 'invitation');
  INSERT INTO invitation (organisation_id, person_id, token_hash, invited_by, expires_at) VALUES (p_org, pid, p_token_hash, app_person_id(), p_expires);
  RETURN pid;
END $$;
REVOKE ALL ON FUNCTION invite_person(uuid, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invite_person(uuid, text, text, text, timestamptz) TO lms_app;

-- ---------------------------------------------------------------------------------------------
-- CPD (LRN-05). The value and unit are set per course by TCGI (DEC-22). Awards snapshot the value at
-- award time, so later edits never rewrite history.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE course ADD COLUMN cpd_value numeric CHECK (cpd_value > 0);
ALTER TABLE course ADD COLUMN cpd_unit text;
ALTER TABLE course ADD CONSTRAINT course_cpd_pair CHECK ((cpd_value IS NULL) = (cpd_unit IS NULL));
-- course_write is platform-only, so only TCGI changes CPD values.

CREATE TABLE cpd_award (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisation(id),
  person_id        uuid NOT NULL REFERENCES person(id),
  enrolment_id     uuid NOT NULL REFERENCES enrolment(id),
  course_id        uuid NOT NULL REFERENCES course(id),
  value            numeric NOT NULL CHECK (value > 0),
  unit             text NOT NULL,
  source_type      text NOT NULL CHECK (source_type IN ('course_completion')),
  source_id        uuid NOT NULL,
  awarded_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id)        -- one award per completion, whatever is replayed or relaunched
);
CREATE INDEX cpd_award_person ON cpd_award (person_id, awarded_at);
CREATE TRIGGER cpd_award_append_only BEFORE UPDATE OR DELETE ON cpd_award FOR EACH ROW EXECUTE FUNCTION reject_modification();
ALTER TABLE cpd_award ENABLE ROW LEVEL SECURITY;
CREATE POLICY cpd_read ON cpd_award FOR SELECT USING (app_is_platform() OR person_id = app_person_id() OR organisation_id = ANY (app_managed_org_ids()));
CREATE POLICY cpd_insert ON cpd_award FOR INSERT WITH CHECK (app_is_platform() OR person_id = app_person_id());
GRANT SELECT, INSERT ON cpd_award TO lms_app;
