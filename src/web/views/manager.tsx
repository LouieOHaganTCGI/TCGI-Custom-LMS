import type { TeamView } from "../../modules/enterprise/enterprise-service.js";
import { EmptyState, fmtDate, fmtNumber, Layout, ProgressBar, StatusBadge, TIER_LABEL, type FlashCode, type NavUser } from "./layout.js";

export function ManagePickPage(props: { user: NavUser; orgs: { id: string; name: string }[] }) {
  return (
    <Layout title="Manage team" user={props.user} active="manage">
      <h1>Manage team</h1>
      {props.orgs.length === 0 ? <EmptyState title="You don't manage any organisations" /> : (
        <ul className="grid grid-3">
          {props.orgs.map((o) => <li key={o.id} className="card"><h2><a href={`/manage/orgs/${o.id}`}>{o.name}</a></h2></li>)}
        </ul>
      )}
    </Layout>
  );
}

export function TeamPage(props: { user: NavUser; view: TeamView; now: Date; flash?: FlashCode | null; inviteLink?: string | undefined; error?: string | undefined }) {
  const { view, user } = props;
  const org = view.organisation;
  const active = view.agreements.filter((a) => a.status === "active" && new Date(a.accessEnd) > props.now);
  const seatsUsed = active.reduce((n, a) => n + a.seatsUsed, 0);
  const seatLimit = active.reduce((n, a) => n + a.seatLimit, 0);
  const courses = [...new Map(active.flatMap((a) => a.courses).map((c) => [c.id, c])).values()];
  const assignable = view.members.filter((m) => m.membershipStatus !== "ended");
  const completedCount = view.members.reduce((n, m) => n + m.enrolments.filter((e) => e.status === "completed").length, 0);
  const inProgress = view.members.reduce((n, m) => n + m.enrolments.filter((e) => e.status === "active").length, 0);
  return (
    <Layout title={`${org.name}: team`} user={user} active="manage" flash={props.flash ?? null}>
      <p className="breadcrumb"><a href="/manage">Manage team</a> › <span aria-current="page">{org.name}</span></p>
      <div className="page-head">
        <div>
          <h1>{org.name}</h1>
          <p className="lede">Your team's learning, seats and course assignments. You only see learning provided through {org.name}.</p>
        </div>
        <a className="button secondary" href={`/manage/orgs/${org.id}/export.csv`} download>Export team progress (CSV)</a>
      </div>
      {props.error ? <p className="error" role="alert">{props.error}</p> : null}
      {props.inviteLink ? (
        <div className="flash flash-ok" role="status">
          <p><strong>Invitation created.</strong> Send this one-time link to the learner. It won't be shown again. (Automatic email delivery is pending DEC-25.)</p>
          <label>Invitation link<input id="invite-link" readOnly value={props.inviteLink} /></label>
          <p><button type="button" className="button small secondary" data-copy="invite-link">Copy link</button></p>
        </div>
      ) : null}

      <ul className="stats" aria-label="Team summary">
        <li className="stat"><span className="stat-value">{seatsUsed} / {seatLimit}</span><span className="stat-label">Seats in use</span></li>
        <li className="stat"><span className="stat-value">{view.members.length}</span><span className="stat-label">Team members</span></li>
        <li className="stat"><span className="stat-value">{inProgress}</span><span className="stat-label">Courses in progress</span></li>
        <li className="stat"><span className="stat-value">{completedCount}</span><span className="stat-label">Courses completed</span></li>
      </ul>

      <h2>Team progress</h2>
      {view.members.length === 0 ? <EmptyState title="No team members yet"><p>Invite your first learner below.</p></EmptyState> : (
        <div className="table-scroll" role="region" aria-label="Team progress" tabIndex={0}>
          <table>
            <thead><tr><th scope="col">Learner</th><th scope="col">Status</th><th scope="col">Courses and progress</th><th scope="col" className="num">CPD</th></tr></thead>
            <tbody>
              {view.members.map((m) => (
                <tr key={m.personId} data-person={m.name}>
                  <td><strong>{m.name}</strong><br /><span className="muted small">{m.email ?? ""}</span></td>
                  <td>
                    <StatusBadge status={m.membershipStatus} />{" "}
                    {m.seatState === "allocated" ? <StatusBadge status="allocated" /> : null}
                    {m.pendingInvitationExpires ? <p className="muted small">Invitation expires {fmtDate(m.pendingInvitationExpires)}</p> : null}
                  </td>
                  <td>
                    {m.enrolments.length === 0 ? <span className="muted">{m.seatState ? "Assigned, not started" : "No courses"}</span> : (
                      <ul className="card-list">
                        {m.enrolments.map((e) => (
                          <li key={e.enrolmentId}>
                            <strong>{e.courseTitle}</strong> <StatusBadge status={e.status} />
                            <ProgressBar done={e.placementsCompleted} total={e.placementsTotal} label={`${m.name}: ${e.courseTitle}`} />
                            {e.completedAt ? <span className="muted small">Completed {fmtDate(e.completedAt)}</span> : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="num">{m.cpd.length === 0 ? "—" : m.cpd.map((c) => `${fmtNumber(c.total)} ${c.unit}`).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid grid-2">
        <section className="card" aria-labelledby="assign-h">
          <h2 id="assign-h">Assign a course</h2>
          {active.length === 0 ? <p>There's no active agreement. Contact TCGI to renew.</p> : (
            <form method="post" action={`/manage/orgs/${org.id}/assignments`} className="form">
              <input type="hidden" name="_csrf" value={user.csrfToken} />
              <label>Learner
                <select name="person_id" required>
                  {assignable.map((m) => <option key={m.personId} value={m.personId}>{m.name}{m.membershipStatus === "invited" ? " (invited)" : ""}</option>)}
                </select>
              </label>
              <label>Course <span className="hint">Courses included in your agreement</span>
                <select name="course_id" required>
                  {courses.map((c) => <option key={c.id} value={c.id}>{c.title} · {TIER_LABEL[c.tier] ?? c.tier}</option>)}
                </select>
              </label>
              <p className="muted small">Assigning a course to someone without a seat uses one seat ({Math.max(seatLimit - seatsUsed, 0)} left).</p>
              <button type="submit" className="button">Assign course</button>
            </form>
          )}
        </section>
        <section className="card" aria-labelledby="invite-h">
          <h2 id="invite-h">Invite a learner</h2>
          <form method="post" action={`/manage/orgs/${org.id}/invitations`} className="form">
            <input type="hidden" name="_csrf" value={user.csrfToken} />
            <label>Full name<input name="name" required maxLength={120} autoComplete="off" /></label>
            <label>Work email <span className="hint">Used to contact them. They sign in with their own TCGI identity.</span><input name="email" type="email" required maxLength={254} autoComplete="off" /></label>
            <button type="submit" className="button">Create invitation</button>
          </form>
        </section>
      </div>

      <h2>Agreements</h2>
      {view.agreements.length === 0 ? <EmptyState title="No agreements on record" /> : (
        <ul className="grid grid-2">
          {view.agreements.map((a) => (
            <li key={a.id} className="card">
              <h3>{a.reference}</h3>
              <dl className="meta">
                <dt>Seats</dt><dd>{a.seatsUsed} of {a.seatLimit} in use</dd>
                <dt>Access</dt><dd>{fmtDate(a.accessStart)} to {fmtDate(a.accessEnd)}</dd>
                <dt>Courses</dt><dd>{a.courses.map((c) => c.title).join(", ")}</dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}
