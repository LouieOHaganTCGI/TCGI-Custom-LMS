import type { ColumnType, Generated } from "kysely";

/** Kysely table typings mirroring src/db/migrations. Keep in sync with every migration. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json = ColumnType<unknown, string, string>;
type Numeric = ColumnType<string | null, number | string | null | undefined, number | string | null>;

export interface OrganisationTable {
  id: Generated<string>;
  slug: string;
  kind: "tcgi_direct" | "enterprise";
  name: string;
  status: Generated<"active" | "inactive">;
  created_at: Generated<Date>;
}

export interface PersonTable {
  id: Generated<string>;
  display_name: string;
  primary_email: string | null;
  email_verified: Generated<boolean>;
  status: Generated<"active" | "suspended" | "deactivated">;
  created_at: Generated<Date>;
  updated_at: Timestamp;
  launch_tokens_valid_after: NullableTimestamp;
}

export interface IdentityLinkTable {
  id: Generated<string>;
  person_id: string;
  issuer: string;
  subject: string;
  linked_via: "provisioning" | "invitation" | "migration" | "self_registration" | "support";
  linked_at: Generated<Date>;
  last_login_at: NullableTimestamp;
}

export interface OrganisationMembershipTable {
  id: Generated<string>;
  organisation_id: string;
  person_id: string;
  status: Generated<"invited" | "active" | "ended">;
  source: string;
  started_at: Generated<Date>;
  ended_at: NullableTimestamp;
}

export type Role = "tcgi_admin" | "enterprise_manager";

export interface RoleGrantTable {
  id: Generated<string>;
  person_id: string;
  role: Role;
  scope_type: "platform" | "organisation";
  organisation_id: string | null;
  valid_from: Timestamp;
  valid_to: NullableTimestamp;
  granted_by: string | null;
  reason: string;
  created_at: Generated<Date>;
}

export interface WebSessionTable {
  id_hash: string;
  person_id: string;
  csrf_token: string;
  identity_link_id: string;
  created_at: Generated<Date>;
  last_seen_at: Timestamp;
  idle_expires_at: Timestamp;
  absolute_expires_at: Timestamp;
  revoked_at: NullableTimestamp;
}

export interface AuthRequestTable {
  id: string;
  state: string;
  nonce: string;
  code_verifier: string;
  return_to: string;
  expires_at: Timestamp;
  invite_token_hash: string | null;
}

export interface ContentItemTable {
  id: Generated<string>;
  stable_key: string;
  title: string;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface ContentVersionTable {
  id: Generated<string>;
  content_item_id: string;
  version_no: number;
  package_sha256: string;
  scorm_version: "1.2" | "2004";
  scorm_edition: string | null;
  manifest_identifier: string;
  title: string;
  launch_href: string;
  file_count: number;
  total_bytes: ColumnType<string, number | string, number | string>;
  runtime_provider: Generated<string>;
  status: Generated<"approved" | "retired">;
  created_by: string | null;
  created_at: Generated<Date>;
}

export type CourseTier = "microlesson" | "foundation" | "professional_certificate" | "advanced_certificate" | "diploma";

export interface CourseTable {
  id: Generated<string>;
  slug: string;
  title: string;
  tier: CourseTier;
  status: Generated<"active" | "retired">;
  created_at: Generated<Date>;
  cpd_value: Numeric;
  cpd_unit: string | null;
}

export interface CourseRevisionTable {
  id: Generated<string>;
  course_id: string;
  revision_no: number;
  state: Generated<"draft" | "published" | "retired">;
  completion_rule_ref: string;
  published_at: NullableTimestamp;
  published_by: string | null;
  created_at: Generated<Date>;
}

export interface CoursePlacementTable {
  id: Generated<string>;
  course_revision_id: string;
  content_item_id: string;
  content_version_id: string;
  position: number;
  title: string;
  required: Generated<boolean>;
}

export interface CommercialProductReferenceTable {
  id: Generated<string>;
  source: string;
  external_product_id: string;
  course_id: string;
  active: Generated<boolean>;
  created_at: Generated<Date>;
}

export type EntitlementStatus = "pending" | "active" | "suspended" | "revoked" | "expired";

export interface EntitlementTable {
  id: Generated<string>;
  organisation_id: string;
  person_id: string;
  course_id: string;
  grant_type: "commerce_line" | "seat" | "manual";
  source: string;
  external_order_id: string;
  external_line_id: string;
  product_ref_id: string | null;
  status: EntitlementStatus;
  valid_from: Timestamp;
  valid_until: NullableTimestamp;
  created_at: Generated<Date>;
  updated_at: Timestamp;
}

export interface EntitlementDecisionTable {
  id: Generated<string>;
  organisation_id: string;
  entitlement_id: string;
  input_ref: Json;
  rule_version: string;
  before: ColumnType<unknown, string | null, never>;
  after: Json;
  decided_at: Generated<Date>;
}

export type EnrolmentStatus = "active" | "completed" | "expired" | "withdrawn";

export interface EnrolmentTable {
  id: Generated<string>;
  organisation_id: string;
  person_id: string;
  course_id: string;
  course_revision_id: string;
  entitlement_id: string;
  status: Generated<EnrolmentStatus>;
  access_start: Timestamp;
  access_end: NullableTimestamp;
  completion_rule_ref: string;
  enrolled_at: Generated<Date>;
  completed_at: NullableTimestamp;
}

export interface AttemptTable {
  id: Generated<string>;
  organisation_id: string;
  enrolment_id: string;
  person_id: string;
  placement_id: string;
  content_version_id: string;
  attempt_no: number;
  runtime_provider: string;
  started_at: Generated<Date>;
  last_commit_at: NullableTimestamp;
  ended_at: NullableTimestamp;
}

export interface LaunchCodeTable {
  code_hash: string;
  attempt_id: string;
  person_id: string;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
}

export interface RuntimeCommitTable {
  id: Generated<string>;
  organisation_id: string;
  attempt_id: string;
  person_id: string;
  seq: number;
  received_at: Generated<Date>;
  payload: Json;
  payload_sha256: string;
  terminate: Generated<boolean>;
}

export type CompletionStatus = "not_attempted" | "incomplete" | "completed" | "unknown";
export type SuccessStatus = "passed" | "failed" | "unknown";

export interface ProgressStateTable {
  attempt_id: string;
  organisation_id: string;
  person_id: string;
  completion_status: Generated<CompletionStatus>;
  success_status: Generated<SuccessStatus>;
  score_raw: Numeric;
  score_min: Numeric;
  score_max: Numeric;
  score_scaled: Numeric;
  location: string | null;
  suspend_data: string | null;
  exit_mode: string | null;
  total_time: string | null;
  first_completed_at: NullableTimestamp;
  last_commit_seq: Generated<number>;
  source: Generated<"client_reported" | "migrated">;
  updated_at: Timestamp;
}

export interface OutboxMessageTable {
  seq: Generated<string>;
  id: string;
  destination: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Json;
  status: Generated<"pending" | "delivered" | "dead">;
  attempts: Generated<number>;
  next_attempt_at: Timestamp;
  last_error: string | null;
  created_at: Generated<Date>;
  delivered_at: NullableTimestamp;
}

export interface DeliveryAttemptTable {
  id: Generated<string>;
  outbox_id: string;
  attempted_at: Generated<Date>;
  http_status: number | null;
  outcome: "delivered" | "retry" | "dead";
  error: string | null;
  duration_ms: number;
}

export interface AuditEntryTable {
  id: Generated<string>;
  occurred_at: Generated<Date>;
  actor_type: "person" | "system" | "service";
  actor_person_id: string | null;
  actor_label: string;
  organisation_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  before: ColumnType<unknown, string | null, never>;
  after: ColumnType<unknown, string | null, never>;
  reason: string | null;
  request_id: string | null;
  prev_hash: ColumnType<string, string | undefined, never>;
  entry_hash: ColumnType<string, string | undefined, never>;
}

export interface IntegrationEventTable {
  id: Generated<string>;
  source: string;
  idempotency_key: string;
  envelope_id: string;
  event_type: string;
  schema_version: string;
  aggregate_id: string;
  effective_at: Timestamp;
  source_sequence: ColumnType<string | null, number | string | null, number | string | null>;
  payload: Json;
  payload_sha256: string;
  received_at: Generated<Date>;
  status: Generated<"received" | "processed" | "held">;
  status_reason: string | null;
  processed_at: NullableTimestamp;
  entitlement_id: string | null;
}

export interface AgreementTable {
  id: Generated<string>;
  organisation_id: string;
  reference: string;
  seat_limit: number;
  access_start: Timestamp;
  access_end: Timestamp;
  status: Generated<"active" | "ended">;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface AgreementCourseTable {
  agreement_id: string;
  course_id: string;
}

export interface SeatAllocationTable {
  id: Generated<string>;
  organisation_id: string;
  agreement_id: string;
  person_id: string;
  state: Generated<"allocated" | "released">;
  allocated_by: string | null;
  allocated_at: Generated<Date>;
  released_by: string | null;
  released_at: NullableTimestamp;
  release_reason: string | null;
}

export interface InvitationTable {
  id: Generated<string>;
  organisation_id: string;
  person_id: string;
  token_hash: string;
  invited_by: string | null;
  created_at: Generated<Date>;
  expires_at: Timestamp;
  accepted_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
}

export interface CpdAwardTable {
  id: Generated<string>;
  organisation_id: string;
  person_id: string;
  enrolment_id: string;
  course_id: string;
  value: ColumnType<string, number | string, never>;
  unit: string;
  source_type: "course_completion";
  source_id: string;
  awarded_at: Generated<Date>;
}

export interface Database {
  integration_event: IntegrationEventTable;
  agreement: AgreementTable;
  agreement_course: AgreementCourseTable;
  seat_allocation: SeatAllocationTable;
  invitation: InvitationTable;
  cpd_award: CpdAwardTable;
  organisation: OrganisationTable;
  person: PersonTable;
  identity_link: IdentityLinkTable;
  organisation_membership: OrganisationMembershipTable;
  role_grant: RoleGrantTable;
  web_session: WebSessionTable;
  auth_request: AuthRequestTable;
  content_item: ContentItemTable;
  content_version: ContentVersionTable;
  course: CourseTable;
  course_revision: CourseRevisionTable;
  course_placement: CoursePlacementTable;
  commercial_product_reference: CommercialProductReferenceTable;
  entitlement: EntitlementTable;
  entitlement_decision: EntitlementDecisionTable;
  enrolment: EnrolmentTable;
  attempt: AttemptTable;
  launch_code: LaunchCodeTable;
  runtime_commit: RuntimeCommitTable;
  progress_state: ProgressStateTable;
  outbox_message: OutboxMessageTable;
  delivery_attempt: DeliveryAttemptTable;
  audit_entry: AuditEntryTable;
}
