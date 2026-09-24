import type { EligibleCourse, EnrolmentSummary } from "../../modules/enrolment/enrolment-service.js";
import type { EnrolmentView } from "../../modules/learning/learning-service.js";
import { fmtDate, fmtDateTime, Layout, StatusBadge, type NavUser } from "./layout.js";

const TIER_LABEL: Record<string, string> = {
  microlesson: "Micro-lesson",
  foundation: "Foundation course",
  professional_certificate: "Professional Certificate",
  advanced_certificate: "Advanced Professional Certificate",
  diploma: "Diploma",
};

export function SignInPage(props: { providerLabel: string; returnTo: string; notice?: string | undefined }) {
  return (
    <Layout title="Sign in">
      <h1>Sign in to TCGI Learning</h1>
      {props.notice ? <p className="notice" role="status">{props.notice}</p> : null}
      <p>You sign in with your TCGI account.</p>
      <p className="muted">Identity provider: <strong>{props.providerLabel}</strong></p>
      <form method="get" action="/auth/login">
        <input type="hidden" name="return_to" value={props.returnTo} />
        <button type="submit" className="button">Sign in</button>
      </form>
    </Layout>
  );
}

export function DeniedPage(props: { reason: string }) {
  const msg =
    props.reason === "person_inactive"
      ? "Your learning account is not active. Please contact TCGI support."
      : "You signed in successfully, but no learning account is linked to this identity yet. If you were invited, please use the link in your invitation email, or contact TCGI support.";
  return (
    <Layout title="Account not available">
      <h1>We couldn't open your learning account</h1>
      <p>{msg}</p>
      <p><a href="/">Back to sign in</a></p>
    </Layout>
  );
}

function progressText(done: number, total: number) {
  return total === 0 ? "No lessons" : `${done} of ${total} lessons completed`;
}

export function DashboardPage(props: { user: NavUser; enrolments: EnrolmentSummary[]; eligible: EligibleCourse[]; now: Date }) {
  const { user, enrolments, eligible } = props;
  const active = enrolments.filter((e) => e.status === "active");
  const next = active.find((e) => e.placementsCompleted < e.placementsTotal);
  return (
    <Layout title="My learning" user={user}>
      <h1>My learning</h1>
      <p className="lede">Welcome, {user.displayName}.</p>

      {next ? (
        <section aria-labelledby="next-heading" className="card highlight">
          <h2 id="next-heading">Next step</h2>
          <p>
            Continue <strong>{next.courseTitle}</strong>: {progressText(next.placementsCompleted, next.placementsTotal)}.
          </p>
          <a className="button" href={`/learn/enrolments/${next.enrolmentId}`}>{next.placementsCompleted > 0 ? "Resume course" : "Start course"}</a>
        </section>
      ) : null}

      <section aria-labelledby="courses-heading">
        <h2 id="courses-heading">My courses</h2>
        {enrolments.length === 0 ? (
          <p>You are not enrolled in any courses yet.</p>
        ) : (
          <ul className="card-list">
            {enrolments.map((e) => (
              <li key={e.enrolmentId} className="card">
                <h3><a href={`/learn/enrolments/${e.enrolmentId}`}>{e.courseTitle}</a></h3>
                <p className="muted">{TIER_LABEL[e.tier] ?? e.tier} · {e.organisationName}</p>
                <p>
                  <StatusBadge status={e.status} /> {progressText(e.placementsCompleted, e.placementsTotal)}
                </p>
                <div className="progress" role="progressbar" aria-label={`Progress in ${e.courseTitle}`} aria-valuemin={0} aria-valuemax={e.placementsTotal} aria-valuenow={e.placementsCompleted}>
                  <span className={`progress-fill w-${e.placementsTotal ? Math.round((e.placementsCompleted / e.placementsTotal) * 10) * 10 : 0}`} />
                </div>
                <dl className="meta">
                  <dt>Access until</dt>
                  <dd>{e.accessEnd ? fmtDate(e.accessEnd) : "No end date"}</dd>
                  {e.completedAt ? (<><dt>Completed</dt><dd>{fmtDate(e.completedAt)}</dd></>) : null}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="available-heading">
        <h2 id="available-heading">Available to you</h2>
        {eligible.length === 0 ? (
          <p>There are no other courses available to you right now.</p>
        ) : (
          <ul className="card-list">
            {eligible.map((c) => (
              <li key={c.courseId} className="card">
                <h3>{c.title}</h3>
                <p className="muted">{TIER_LABEL[c.tier] ?? c.tier} · Access until {c.accessEnd ? fmtDate(c.accessEnd) : "no end date"}</p>
                <form method="post" action={`/learn/courses/${c.courseId}/enrol`}>
                  <input type="hidden" name="_csrf" value={user.csrfToken} />
                  <button type="submit" className="button">Enrol in {c.title}</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Layout>
  );
}

export function EnrolmentPage(props: { user: NavUser; view: EnrolmentView }) {
  const { user, view } = props;
  return (
    <Layout title={view.courseTitle} user={user}>
      <p><a href="/learn">← My learning</a></p>
      <h1>{view.courseTitle}</h1>
      <p className="muted">{TIER_LABEL[view.courseTier] ?? view.courseTier} · {view.organisationName} · Course version {view.revisionNo}</p>
      <p>
        <StatusBadge status={view.status} />{" "}
        {view.status === "completed" ? <strong>Course completed on {fmtDate(view.completedAt)}.</strong> : null}
      </p>
      <dl className="meta">
        <dt>Access until</dt>
        <dd>{view.accessEnd ? fmtDateTime(view.accessEnd) : "No end date"}</dd>
      </dl>
      <h2>Lessons</h2>
      <ol className="lesson-list">
        {view.placements.map((p) => (
          <li key={p.placementId} className="card">
            <h3>{p.title}</h3>
            <p>
              <StatusBadge status={p.completion} />
              {p.success !== "unknown" ? <> <StatusBadge status={p.success} /></> : null}
              {p.scoreRaw !== null ? <span className="muted"> Score reported by the lesson: {Number(p.scoreRaw)}</span> : null}
            </p>
            {p.firstCompletedAt ? <p className="muted">First completed {fmtDateTime(p.firstCompletedAt)}</p> : null}
            <form method="post" action={`/learn/enrolments/${view.enrolmentId}/placements/${p.placementId}/launch`}>
              <input type="hidden" name="_csrf" value={user.csrfToken} />
              <button type="submit" className="button">
                {p.firstCompletedAt ? "Review lesson" : p.started ? "Resume lesson" : "Start lesson"}
                <span className="visually-hidden">: {p.title}</span>
              </button>
            </form>
          </li>
        ))}
      </ol>
    </Layout>
  );
}

export function MePage(props: {
  user: NavUser;
  person: { id: string; display_name: string; primary_email: string | null; email_verified: boolean; status: string };
  links: { issuer: string; subject: string; linked_via: string; last_login_at: Date | null }[];
  memberships: { name: string; kind: string; status: string }[];
  grants: { role: string; scope_type: string; org_name: string | null }[];
}) {
  const { person, links, memberships, grants } = props;
  return (
    <Layout title="My account" user={props.user}>
      <h1>My account</h1>
      <p className="muted">This page shows how the LMS identifies you. Your sign-in identity (issuer and subject) is the key, and your email address is only a contact detail.</p>
      <h2>Person</h2>
      <dl className="meta">
        <dt>LMS person ID</dt><dd><code>{person.id}</code></dd>
        <dt>Name</dt><dd>{person.display_name}</dd>
        <dt>Email</dt><dd>{person.primary_email ?? "—"} {person.email_verified ? "(verified by identity provider)" : "(not verified)"}</dd>
        <dt>Status</dt><dd>{person.status}</dd>
      </dl>
      <h2>Sign-in identities</h2>
      <table>
        <caption className="visually-hidden">Identity links</caption>
        <thead><tr><th scope="col">Issuer</th><th scope="col">Subject</th><th scope="col">Linked via</th><th scope="col">Last sign-in</th></tr></thead>
        <tbody>
          {links.map((l) => (
            <tr key={l.issuer + l.subject}><td><code>{l.issuer}</code></td><td><code>{l.subject}</code></td><td>{l.linked_via}</td><td>{fmtDateTime(l.last_login_at)}</td></tr>
          ))}
        </tbody>
      </table>
      <h2>Organisations</h2>
      <ul>{memberships.map((m) => <li key={m.name}>{m.name} ({m.kind === "tcgi_direct" ? "TCGI direct learner" : "enterprise"}) · {m.status}</li>)}</ul>
      <h2>Roles</h2>
      {grants.length === 0 ? <p>Learner (no additional roles).</p> : (
        <ul>{grants.map((g, i) => <li key={i}>{g.role} · {g.scope_type === "platform" ? "TCGI platform" : g.org_name}</li>)}</ul>
      )}
    </Layout>
  );
}
