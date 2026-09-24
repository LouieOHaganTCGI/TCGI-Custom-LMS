import type { ReactNode } from "react";
import type { AuditFilter, AuditRow } from "../../modules/admin/admin-queries.js";
import { EmptyState, fmtDateTime, fmtNumber, Layout, StatusBadge, TIER_LABEL, type FlashCode, type NavUser } from "./layout.js";

export type AdminSection = "overview" | "audit" | "integrations" | "inbound" | "content" | "organisations" | "mappings";

const SECTIONS: { key: AdminSection; href: string; label: string }[] = [
  { key: "overview", href: "/admin", label: "Overview" },
  { key: "organisations", href: "/admin/organisations", label: "Organisations and seats" },
  { key: "content", href: "/admin/content", label: "Content and courses" },
  { key: "mappings", href: "/admin/mappings", label: "Commerce product mappings" },
  { key: "inbound", href: "/admin/entitlement-events", label: "Purchase and refund events" },
  { key: "integrations", href: "/admin/integrations", label: "Outbound events" },
  { key: "audit", href: "/admin/audit", label: "Audit trail" },
];

export function AdminShell(props: { user: NavUser; title: string; section: AdminSection; children: ReactNode; flash?: FlashCode | null; lede?: string }) {
  return (
    <Layout title={props.title} user={props.user} active="admin" flash={props.flash ?? null}>
      <div className="admin-layout">
        <nav className="side-nav" aria-label="Administration">
          <ul>{SECTIONS.map((s) => <li key={s.key}><a href={s.href} {...(s.key === props.section ? { "aria-current": "page" as const } : {})}>{s.label}</a></li>)}</ul>
        </nav>
        <div>
          <h1>{props.title}</h1>
          {props.lede ? <p className="lede">{props.lede}</p> : null}
          {props.children}
        </div>
      </div>
    </Layout>
  );
}

export interface OverviewStats {
  activeLearners: number;
  activeEnrolments: number;
  completions30d: number;
  expiring30d: number;
  outboxDead: number;
  outboxPending: number;
  inboundHeld: number;
  organisations: number;
  generatedAt: Date;
}

export function AdminOverviewPage(props: { user: NavUser; stats: OverviewStats; flash?: FlashCode | null }) {
  const s = props.stats;
  const tile = (value: number, label: string, href?: string, warn = false) => (
    <li className="stat">
      <span className="stat-value">{fmtNumber(value)}</span>
      <span className="stat-label">{href ? <a href={href}>{label}</a> : label}</span>
      {warn && value > 0 ? <StatusBadge status="held" label="Needs attention" /> : null}
    </li>
  );
  return (
    <AdminShell user={props.user} title="Operations overview" section="overview" flash={props.flash ?? null}>
      <p className="muted small">Live counts from transactional records. Generated {fmtDateTime(s.generatedAt)}.</p>
      <h2>Learning</h2>
      <ul className="stats">
        {tile(s.activeLearners, "Learners with active enrolments")}
        {tile(s.activeEnrolments, "Active enrolments")}
        {tile(s.completions30d, "Completions (30 days)")}
        {tile(s.expiring30d, "Access ending within 30 days")}
      </ul>
      <h2>Integrations and operations</h2>
      <ul className="stats">
        {tile(s.inboundHeld, "Purchase/refund events held for review", "/admin/entitlement-events?status=held", true)}
        {tile(s.outboxDead, "Outbound events dead-lettered", "/admin/integrations", true)}
        {tile(s.outboxPending, "Outbound events pending", "/admin/integrations")}
        {tile(s.organisations, "Enterprise organisations", "/admin/organisations")}
      </ul>
    </AdminShell>
  );
}

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function AdminAuditPage(props: { user: NavUser; rows: AuditRow[]; filter: AuditFilter }) {
  const { rows, filter } = props;
  const last = rows.at(-1);
  const qs = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ action: filter.action, entity_type: filter.entityType, entity_id: filter.entityId, ...extra })) if (v) p.set(k, v);
    return `?${p.toString()}`;
  };
  return (
    <AdminShell user={props.user} title="Audit trail" section="audit" lede="Every access, academic and integration change, with the actor, reason, and before and after values. Entries are append-only and hash-chained.">
      <form method="get" action="/admin/audit" className="filters card">
        <label>Action <input name="action" defaultValue={filter.action ?? ""} placeholder="for example enrolment.created" /></label>
        <label>Entity type <input name="entity_type" defaultValue={filter.entityType ?? ""} /></label>
        <label>Entity ID <input name="entity_id" defaultValue={filter.entityId ?? ""} /></label>
        <button type="submit" className="button">Filter</button>
      </form>
      {rows.length === 0 ? <EmptyState title="No audit entries match" /> : (
        <div className="table-scroll" role="region" aria-label="Audit entries" tabIndex={0}>
          <table>
            <thead>
              <tr><th scope="col">#</th><th scope="col">When</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Entity</th><th scope="col">Organisation</th><th scope="col">Change</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-action={r.action}>
                  <td>{r.id}</td>
                  <td>{fmtDateTime(r.occurredAt)}</td>
                  <td>{r.actorLabel} <span className="muted">({r.actorType})</span></td>
                  <td><code>{r.action}</code></td>
                  <td><a href={`/admin/audit${qs({ entity_type: r.entityType, entity_id: r.entityId, action: undefined })}`}>{r.entityType} <code>{r.entityId.slice(0, 13)}</code></a></td>
                  <td>{r.organisation ?? "—"}</td>
                  <td>
                    <details><summary>View</summary>
                      <p>Before</p><Json value={r.before} /><p>After</p><Json value={r.after} />
                      {r.reason ? <p>Reason: {r.reason}</p> : null}
                      <p className="muted">Chain hash <code>{r.entryHash.slice(0, 16)}…</code></p>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {last && rows.length >= 50 ? <p><a className="button secondary" href={`/admin/audit${qs({ before: last.id })}`}>Older entries</a></p> : null}
    </AdminShell>
  );
}

type OutboxRow = {
  id: string; seq: string; destination: string; event_type: string; aggregate_type: string; aggregate_id: string; status: "pending" | "delivered" | "dead";
  attempts: number; next_attempt_at: Date; last_error: string | null; created_at: Date; delivered_at: Date | null;
  deliveries: { attempted_at: Date; http_status: number | null; outcome: string; error: string | null; duration_ms: number }[];
};

export function AdminIntegrationsPage(props: { user: NavUser; rows: OutboxRow[]; destinationNote: string }) {
  return (
    <AdminShell user={props.user} title="Outbound events" section="integrations" lede="Events the LMS publishes (enrolments, completions), their delivery attempts, dead letters and replay.">
      <p className="notice" role="note">{props.destinationNote}</p>
      {props.rows.length === 0 ? <EmptyState title="No outbound events yet" /> : (
        <div className="table-scroll" role="region" aria-label="Outbound events" tabIndex={0}>
          <table>
            <thead><tr><th scope="col">Event</th><th scope="col">Destination</th><th scope="col">Aggregate</th><th scope="col">Status</th><th scope="col" className="num">Attempts</th><th scope="col">Created</th><th scope="col">Detail</th></tr></thead>
            <tbody>
              {props.rows.map((m) => (
                <tr key={m.id} data-event-type={m.event_type} data-status={m.status}>
                  <td><code>{m.event_type}</code><br /><span className="muted"><code>{m.id}</code></span></td>
                  <td>{m.destination}</td>
                  <td>{m.aggregate_type} <code>{m.aggregate_id.slice(0, 13)}</code></td>
                  <td><StatusBadge status={m.status} /></td>
                  <td className="num">{m.attempts}</td>
                  <td>{fmtDateTime(m.created_at)}</td>
                  <td>
                    <details><summary>Deliveries ({m.deliveries.length})</summary>
                      <ul>{m.deliveries.map((d, i) => <li key={i}>{fmtDateTime(d.attempted_at)} · {d.outcome} · HTTP {d.http_status ?? "—"} · {d.duration_ms} ms {d.error ? `· ${d.error}` : ""}</li>)}</ul>
                      {m.last_error ? <p>Last error: {m.last_error}</p> : null}
                    </details>
                    {m.status === "dead" ? (
                      <form method="post" action={`/admin/integrations/${m.id}/replay`}>
                        <input type="hidden" name="_csrf" value={props.user.csrfToken} />
                        <button type="submit" className="button small">Replay</button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}

export function AdminContentPage(props: {
  user: NavUser;
  versions: { id: string; stable_key: string; version_no: number; title: string; scorm_version: string; scorm_edition: string | null; package_sha256: string; file_count: number; created_at: Date; status: string }[];
  courses: { id: string; slug: string; title: string; tier: string; revision_no: number | null; published_at: Date | null; cpd_value: string | null; cpd_unit: string | null }[];
  message?: string | undefined;
  error?: string | undefined;
  flash?: FlashCode | null;
}) {
  return (
    <AdminShell user={props.user} title="Content and courses" section="content" flash={props.flash ?? null}
      lede="Upload SCORM packages as immutable versions, place them in courses, and set CPD values.">
      {props.message ? <p className="flash flash-ok" role="status">{props.message}</p> : null}
      {props.error ? <p className="error" role="alert">{props.error}</p> : null}

      <div className="grid grid-2">
        <section className="card" aria-labelledby="upload-h">
          <h2 id="upload-h">Upload a SCORM package</h2>
          <form method="post" action="/admin/content/upload" encType="multipart/form-data" className="form">
            <input type="hidden" name="_csrf" value={props.user.csrfToken} />
            <label>Content key <span className="hint">A stable identifier, for example governance-101-lesson-1</span><input name="stable_key" required pattern="[a-z0-9][a-z0-9._\-]{1,127}" /></label>
            <label>SCORM zip package<input type="file" name="package" accept=".zip,application/zip" required /></label>
            <button type="submit" className="button">Upload and validate</button>
          </form>
        </section>
        <section className="card" aria-labelledby="course-h">
          <h2 id="course-h">Create and publish a course</h2>
          <p className="muted small">Phase B shortcut: creates revision 1 and publishes it. The draft, review and approve workflow is slice S6.</p>
          <form method="post" action="/admin/courses" className="form">
            <input type="hidden" name="_csrf" value={props.user.csrfToken} />
            <label>Course slug<input name="slug" required pattern="[a-z0-9\-]{2,96}" /></label>
            <label>Title<input name="title" required maxLength={200} /></label>
            <label>Tier
              <select name="tier" required defaultValue="microlesson">
                {Object.entries(TIER_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label>Content version IDs <span className="hint">One per line, in lesson order. The same version can be placed in several courses.</span><textarea name="content_version_ids" required rows={3} /></label>
            <button type="submit" className="button">Create and publish</button>
          </form>
        </section>
      </div>

      <h2>Courses</h2>
      {props.courses.length === 0 ? <EmptyState title="No courses yet" /> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th scope="col">Course</th><th scope="col">Tier</th><th scope="col">Published</th><th scope="col">CPD per completion</th></tr></thead>
            <tbody>
              {props.courses.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.title}</strong><br /><code className="muted">{c.slug}</code></td>
                  <td>{TIER_LABEL[c.tier] ?? c.tier}</td>
                  <td>{c.revision_no ? `Revision ${c.revision_no}, ${fmtDateTime(c.published_at)}` : "Unpublished"}</td>
                  <td>
                    <form method="post" action={`/admin/courses/${c.id}/cpd`} className="actions">
                      <input type="hidden" name="_csrf" value={props.user.csrfToken} />
                      <label className="visually-hidden" htmlFor={`cpd-${c.id}`}>CPD value for {c.title}</label>
                      <input id={`cpd-${c.id}`} name="cpd_value" inputMode="decimal" defaultValue={c.cpd_value ?? ""} placeholder="none" size={5} />
                      <label className="visually-hidden" htmlFor={`cpdu-${c.id}`}>CPD unit for {c.title}</label>
                      <input id={`cpdu-${c.id}`} name="cpd_unit" defaultValue={c.cpd_unit ?? ""} placeholder="unit" size={10} />
                      <button type="submit" className="button small secondary">Save<span className="visually-hidden"> CPD for {c.title}</span></button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Content versions</h2>
      {props.versions.length === 0 ? <EmptyState title="No packages uploaded yet" /> : (
        <div className="table-scroll" role="region" aria-label="Content versions" tabIndex={0}>
          <table>
            <thead><tr><th scope="col">Key</th><th scope="col">Version</th><th scope="col">Title</th><th scope="col">SCORM</th><th scope="col" className="num">Files</th><th scope="col">Package SHA-256</th><th scope="col">ID</th></tr></thead>
            <tbody>
              {props.versions.map((v) => (
                <tr key={v.id}><td>{v.stable_key}</td><td>v{v.version_no}</td><td>{v.title}</td><td>{v.scorm_version}{v.scorm_edition ? ` (${v.scorm_edition})` : ""}</td><td className="num">{v.file_count}</td><td><code>{v.package_sha256.slice(0, 12)}…</code></td><td><code>{v.id}</code></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}

// ------------------------------------------------------------------------------------------ organisations (S5)

export function AdminOrganisationsPage(props: { user: NavUser; orgs: { id: string; name: string; slug: string; members: number; seatsUsed: number; seatLimit: number }[]; flash?: FlashCode | null; error?: string | undefined }) {
  return (
    <AdminShell user={props.user} title="Organisations and seats" section="organisations" flash={props.flash ?? null}
      lede="Enterprise clients, their agreements, seats and managers. Agreement terms are entered from the client contract (DEC-12). None are defaulted.">
      {props.error ? <p className="error" role="alert">{props.error}</p> : null}
      {props.orgs.length === 0 ? <EmptyState title="No enterprise organisations yet" /> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th scope="col">Organisation</th><th scope="col" className="num">Members</th><th scope="col" className="num">Seats in use</th></tr></thead>
            <tbody>{props.orgs.map((o) => (
              <tr key={o.id}><td><a href={`/admin/organisations/${o.id}`}><strong>{o.name}</strong></a><br /><code className="muted">{o.slug}</code></td><td className="num">{o.members}</td><td className="num">{o.seatsUsed} / {o.seatLimit}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <section className="card" aria-labelledby="org-new">
        <h2 id="org-new">Add an organisation</h2>
        <form method="post" action="/admin/organisations" className="form">
          <input type="hidden" name="_csrf" value={props.user.csrfToken} />
          <div className="form-row">
            <label>Name<input name="name" required maxLength={200} /></label>
            <label>Slug <span className="hint">lowercase-with-hyphens</span><input name="slug" required pattern="[a-z0-9\-]{2,64}" /></label>
          </div>
          <button type="submit" className="button">Create organisation</button>
        </form>
      </section>
    </AdminShell>
  );
}

type OrgDetail = {
  org: { id: string; name: string; slug: string };
  agreements: { id: string; reference: string; seatLimit: number; seatsUsed: number; accessStart: Date; accessEnd: Date; status: string; courses: { id: string; title: string }[] }[];
  members: { id: string; display_name: string; primary_email: string | null; status: string }[];
  seats: { id: string; state: string; allocated_at: Date; released_at: Date | null; display_name: string; reference: string }[];
  managers: { id: string; display_name: string; created_at: Date }[];
  courses: { id: string; title: string; tier: string }[];
};

export function AdminOrganisationPage(props: { user: NavUser; d: OrgDetail; flash?: FlashCode | null; error?: string | undefined; inviteLink?: string | undefined }) {
  const { d, user } = props;
  const csrf = <input type="hidden" name="_csrf" value={user.csrfToken} />;
  return (
    <AdminShell user={user} title={d.org.name} section="organisations" flash={props.flash ?? null}>
      <p className="breadcrumb"><a href="/admin/organisations">Organisations</a> › <span aria-current="page">{d.org.name}</span></p>
      {props.error ? <p className="error" role="alert">{props.error}</p> : null}
      {props.inviteLink ? (
        <div className="flash flash-ok" role="status">
          <p><strong>Invitation created.</strong> One-time link (it won't be shown again):</p>
          <label>Invitation link<input id="invite-link" readOnly value={props.inviteLink} /></label>
          <p><button type="button" className="button small secondary" data-copy="invite-link">Copy link</button></p>
        </div>
      ) : null}
      <h2>Agreements</h2>
      {d.agreements.length === 0 ? <EmptyState title="No agreements yet" /> : (
        <ul className="grid grid-2">{d.agreements.map((a) => (
          <li key={a.id} className="card"><h3>{a.reference}</h3>
            <dl className="meta"><dt>Seats</dt><dd>{a.seatsUsed} of {a.seatLimit}</dd><dt>Access</dt><dd>{fmtDateTime(a.accessStart)} to {fmtDateTime(a.accessEnd)}</dd>
              <dt>Courses</dt><dd>{a.courses.map((c) => c.title).join(", ")}</dd></dl></li>
        ))}</ul>
      )}
      <section className="card" aria-labelledby="agr-new">
        <h2 id="agr-new">Add an agreement</h2>
        <form method="post" action={`/admin/organisations/${d.org.id}/agreements`} className="form">
          {csrf}
          <div className="form-row">
            <label>Contract reference<input name="reference" required maxLength={100} /></label>
            <label>Seat limit<input name="seat_limit" type="number" min={1} required /></label>
            <label>Access start<input name="access_start" type="date" required /></label>
            <label>Access end<input name="access_end" type="date" required /></label>
          </div>
          <fieldset><legend>Courses included</legend>
            {d.courses.map((c) => <label key={c.id} className="actions"><input type="checkbox" name="course_ids" value={c.id} /> {c.title}</label>)}
          </fieldset>
          <button type="submit" className="button">Create agreement</button>
        </form>
      </section>

      <div className="grid grid-2">
        <section className="card" aria-labelledby="mem-h">
          <h2 id="mem-h">Members and managers</h2>
          <ul>{d.members.map((m) => <li key={m.id}>{m.display_name} <span className="muted small">{m.primary_email}</span> <StatusBadge status={m.status} />
            {d.managers.some((g) => g.display_name === m.display_name) ? <> <StatusBadge status="processed" label="Manager" /></> : null}</li>)}</ul>
          <form method="post" action={`/admin/organisations/${d.org.id}/managers`} className="form">
            {csrf}
            <label>Make a member a manager
              <select name="person_id" required>{d.members.filter((m) => m.status === "active").map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select>
            </label>
            <button type="submit" className="button secondary">Grant manager role</button>
          </form>
        </section>
        <section className="card" aria-labelledby="inv-h">
          <h2 id="inv-h">Invite someone</h2>
          <form method="post" action={`/admin/organisations/${d.org.id}/invitations`} className="form">
            {csrf}
            <label>Full name<input name="name" required maxLength={120} /></label>
            <label>Email<input name="email" type="email" required maxLength={254} /></label>
            <button type="submit" className="button">Create invitation</button>
          </form>
        </section>
      </div>

      <h2>Seats</h2>
      {d.seats.length === 0 ? <EmptyState title="No seats allocated yet" /> : (
        <div className="table-scroll"><table>
          <thead><tr><th scope="col">Learner</th><th scope="col">Agreement</th><th scope="col">State</th><th scope="col">Allocated</th><th scope="col">Action</th></tr></thead>
          <tbody>{d.seats.map((s) => (
            <tr key={s.id}><td>{s.display_name}</td><td>{s.reference}</td><td><StatusBadge status={s.state} /></td><td>{fmtDateTime(s.allocated_at)}</td>
              <td>{s.state === "allocated" ? (
                <form method="post" action={`/admin/seats/${s.id}/release`} className="actions">
                  {csrf}
                  <label className="visually-hidden" htmlFor={`r-${s.id}`}>Reason for releasing {s.display_name}'s seat</label>
                  <input id={`r-${s.id}`} name="reason" required placeholder="Reason" maxLength={200} />
                  <button type="submit" className="button small danger">Release seat</button>
                </form>
              ) : <span className="muted small">Released {fmtDateTime(s.released_at)}</span>}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </AdminShell>
  );
}

// ------------------------------------------------------------------------------------------ inbound events (S4)

type InboundRow = { id: string; source: string; event_type: string; aggregate_id: string; effective_at: Date; received_at: Date; status: string; status_reason: string | null;
  payload: unknown; entitlement_id: string | null; entitlement_status: string | null; valid_until: Date | null; learner: string | null; course: string | null };

export function AdminInboundPage(props: { user: NavUser; rows: InboundRow[]; status?: string | undefined; flash?: FlashCode | null }) {
  return (
    <AdminShell user={props.user} title="Purchase and refund events" section="inbound" flash={props.flash ?? null}
      lede="Signed entitlement events received from commerce. Each order line's access is re-derived from all of its events. Events the proposed rules (DEC-11) don't cover are held here for review.">
      <form method="get" action="/admin/entitlement-events" className="actions">
        <label>Status
          <select name="status" defaultValue={props.status ?? ""}><option value="">All</option><option value="held">Held for review</option><option value="processed">Processed</option><option value="received">Received</option></select>
        </label>
        <button type="submit" className="button small secondary">Filter</button>
      </form>
      {props.rows.length === 0 ? <EmptyState title="No events" /> : (
        <div className="table-scroll" role="region" aria-label="Inbound events" tabIndex={0}>
          <table>
            <thead><tr><th scope="col">Event</th><th scope="col">Order line</th><th scope="col">Effective</th><th scope="col">Status</th><th scope="col">Resulting access</th><th scope="col">Detail</th></tr></thead>
            <tbody>{props.rows.map((r) => (
              <tr key={r.id} data-event-type={r.event_type} data-status={r.status}>
                <td><code>{r.event_type}</code><br /><span className="muted small">{r.source}</span></td>
                <td><code>{r.aggregate_id}</code></td>
                <td>{fmtDateTime(r.effective_at)}<br /><span className="muted small">received {fmtDateTime(r.received_at)}</span></td>
                <td><StatusBadge status={r.status} />{r.status_reason ? <p className="small">{r.status_reason}</p> : null}</td>
                <td>{r.entitlement_id ? <>{r.learner} · {r.course}<br /><StatusBadge status={r.entitlement_status ?? "unknown"} /> {r.valid_until ? <span className="small">until {fmtDateTime(r.valid_until)}</span> : null}</> : <span className="muted">—</span>}</td>
                <td>
                  <details><summary>Payload</summary><pre className="json">{JSON.stringify(r.payload, null, 2)}</pre></details>
                  {r.status !== "processed" ? (
                    <form method="post" action={`/admin/entitlement-events/${r.id}/reprocess`}>
                      <input type="hidden" name="_csrf" value={props.user.csrfToken} />
                      <button type="submit" className="button small">Reprocess line</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}

export function AdminMappingsPage(props: { user: NavUser; mappings: { id: string; source: string; external_product_id: string; active: boolean; title: string }[]; courses: { id: string; title: string }[]; flash?: FlashCode | null; error?: string | undefined }) {
  return (
    <AdminShell user={props.user} title="Commerce product mappings" section="mappings" flash={props.flash ?? null}
      lede="Which commerce product grants which course. Prices stay in the commerce system. Events for unmapped products are held.">
      {props.error ? <p className="error" role="alert">{props.error}</p> : null}
      {props.mappings.length === 0 ? <EmptyState title="No mappings yet" /> : (
        <div className="table-scroll"><table>
          <thead><tr><th scope="col">Source</th><th scope="col">Product ID</th><th scope="col">Course</th></tr></thead>
          <tbody>{props.mappings.map((m) => <tr key={m.id}><td><code>{m.source}</code></td><td><code>{m.external_product_id}</code></td><td>{m.title}</td></tr>)}</tbody>
        </table></div>
      )}
      <section className="card" aria-labelledby="map-new">
        <h2 id="map-new">Add a mapping</h2>
        <form method="post" action="/admin/mappings" className="form">
          <input type="hidden" name="_csrf" value={props.user.csrfToken} />
          <div className="form-row">
            <label>Source<input name="source" required placeholder="woocommerce:tcgi-store-staging" /></label>
            <label>External product ID<input name="external_product_id" required /></label>
          </div>
          <label>Course<select name="course_id" required>{props.courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
          <button type="submit" className="button">Create mapping</button>
        </form>
      </section>
    </AdminShell>
  );
}
