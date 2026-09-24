import type { AuditFilter, AuditRow } from "../../modules/admin/admin-queries.js";
import { fmtDateTime, Layout, StatusBadge, type NavUser } from "./layout.js";

export function AdminHome(props: { user: NavUser }) {
  return (
    <Layout title="Admin" user={props.user}>
      <h1>TCGI administration</h1>
      <ul className="card-list">
        <li className="card"><h2><a href="/admin/audit">Audit trail</a></h2><p>Every access, academic and integration change, with the actor and reason.</p></li>
        <li className="card"><h2><a href="/admin/integrations">Integration events</a></h2><p>Outbound events (HubSpot destination), delivery attempts, dead letters and replay.</p></li>
        <li className="card"><h2><a href="/admin/content">Content and courses</a></h2><p>Upload SCORM packages, which become immutable versions, and create courses.</p></li>
      </ul>
    </Layout>
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
    <Layout title="Audit trail" user={props.user}>
      <p><a href="/admin">← Admin</a></p>
      <h1>Audit trail</h1>
      <form method="get" action="/admin/audit" className="filters">
        <label>Action <input name="action" defaultValue={filter.action ?? ""} placeholder="for example enrolment.created" /></label>
        <label>Entity type <input name="entity_type" defaultValue={filter.entityType ?? ""} /></label>
        <label>Entity ID <input name="entity_id" defaultValue={filter.entityId ?? ""} /></label>
        <button type="submit" className="button">Filter</button>
      </form>
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
      {rows.length === 0 ? <p>No audit entries match.</p> : null}
      {last && rows.length >= 50 ? <p><a href={`/admin/audit${qs({ before: last.id })}`}>Older entries</a></p> : null}
    </Layout>
  );
}

type OutboxRow = {
  id: string; seq: string; destination: string; event_type: string; aggregate_type: string; aggregate_id: string; status: "pending" | "delivered" | "dead";
  attempts: number; next_attempt_at: Date; last_error: string | null; created_at: Date; delivered_at: Date | null;
  deliveries: { attempted_at: Date; http_status: number | null; outcome: string; error: string | null; duration_ms: number }[];
};

export function AdminIntegrationsPage(props: { user: NavUser; rows: OutboxRow[]; destinationNote: string }) {
  return (
    <Layout title="Integration events" user={props.user}>
      <p><a href="/admin">← Admin</a></p>
      <h1>Integration events</h1>
      <p className="notice" role="note">{props.destinationNote}</p>
      <div className="table-scroll" role="region" aria-label="Outbound events" tabIndex={0}>
        <table>
          <thead><tr><th scope="col">Event</th><th scope="col">Destination</th><th scope="col">Aggregate</th><th scope="col">Status</th><th scope="col">Attempts</th><th scope="col">Created</th><th scope="col">Detail</th></tr></thead>
          <tbody>
            {props.rows.map((m) => (
              <tr key={m.id} data-event-type={m.event_type} data-status={m.status}>
                <td><code>{m.event_type}</code><br /><span className="muted"><code>{m.id}</code></span></td>
                <td>{m.destination}</td>
                <td>{m.aggregate_type} <code>{m.aggregate_id.slice(0, 13)}</code></td>
                <td><StatusBadge status={m.status} /></td>
                <td>{m.attempts}</td>
                <td>{fmtDateTime(m.created_at)}</td>
                <td>
                  <details><summary>Deliveries ({m.deliveries.length})</summary>
                    <ul>{m.deliveries.map((d, i) => <li key={i}>{fmtDateTime(d.attempted_at)} · {d.outcome} · HTTP {d.http_status ?? "—"} · {d.duration_ms} ms {d.error ? `· ${d.error}` : ""}</li>)}</ul>
                    {m.last_error ? <p>Last error: {m.last_error}</p> : null}
                  </details>
                  {m.status === "dead" ? (
                    <form method="post" action={`/admin/integrations/${m.id}/replay`}>
                      <input type="hidden" name="_csrf" value={props.user.csrfToken} />
                      <button type="submit" className="button">Replay</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

export function AdminContentPage(props: {
  user: NavUser;
  versions: { id: string; stable_key: string; version_no: number; title: string; scorm_version: string; scorm_edition: string | null; package_sha256: string; file_count: number; created_at: Date; status: string }[];
  courses: { id: string; slug: string; title: string; tier: string; revision_no: number | null; published_at: Date | null }[];
  message?: string | undefined;
  error?: string | undefined;
}) {
  return (
    <Layout title="Content and courses" user={props.user}>
      <p><a href="/admin">← Admin</a></p>
      <h1>Content and courses</h1>
      {props.message ? <p className="notice" role="status">{props.message}</p> : null}
      {props.error ? <p className="error" role="alert">{props.error}</p> : null}

      <h2>Upload a SCORM package</h2>
      <form method="post" action="/admin/content/upload" encType="multipart/form-data" className="stack">
        <input type="hidden" name="_csrf" value={props.user.csrfToken} />
        <label>Content key (stable identifier, for example <code>governance-101-lesson-1</code>)<input name="stable_key" required pattern="[a-z0-9][a-z0-9._\-]{1,127}" /></label>
        <label>SCORM zip package<input type="file" name="package" accept=".zip,application/zip" required /></label>
        <button type="submit" className="button">Upload and validate</button>
      </form>

      <h2>Content versions</h2>
      <div className="table-scroll" role="region" aria-label="Content versions" tabIndex={0}>
        <table>
          <thead><tr><th scope="col">Key</th><th scope="col">Version</th><th scope="col">Title</th><th scope="col">SCORM</th><th scope="col">Files</th><th scope="col">Package SHA-256</th><th scope="col">ID</th></tr></thead>
          <tbody>
            {props.versions.map((v) => (
              <tr key={v.id}><td>{v.stable_key}</td><td>v{v.version_no}</td><td>{v.title}</td><td>{v.scorm_version}{v.scorm_edition ? ` (${v.scorm_edition})` : ""}</td><td>{v.file_count}</td><td><code>{v.package_sha256.slice(0, 12)}…</code></td><td><code>{v.id}</code></td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Create and publish a course</h2>
      <p className="muted">Phase B shortcut: one step creates revision 1 and publishes it. The draft, review and approve workflow is slice S6.</p>
      <form method="post" action="/admin/courses" className="stack">
        <input type="hidden" name="_csrf" value={props.user.csrfToken} />
        <label>Course slug<input name="slug" required pattern="[a-z0-9\-]{2,96}" /></label>
        <label>Title<input name="title" required maxLength={200} /></label>
        <label>Tier
          <select name="tier" required defaultValue="microlesson">
            <option value="microlesson">Micro-lesson</option><option value="foundation">Foundation course</option>
            <option value="professional_certificate">Professional Certificate</option><option value="advanced_certificate">Advanced Professional Certificate</option>
            <option value="diploma">Diploma</option>
          </select>
        </label>
        <label>Content version IDs, one per line, in lesson order<textarea name="content_version_ids" required rows={3} /></label>
        <button type="submit" className="button">Create and publish</button>
      </form>

      <h2>Courses</h2>
      <ul>{props.courses.map((c) => <li key={c.id}>{c.title} (<code>{c.slug}</code>, {c.tier}) · {c.revision_no ? `revision ${c.revision_no} published ${fmtDateTime(c.published_at)}` : "unpublished"} · <code>{c.id}</code></li>)}</ul>
    </Layout>
  );
}
