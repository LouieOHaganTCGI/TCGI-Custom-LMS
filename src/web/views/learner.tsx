import type { EligibleCourse, EnrolmentSummary } from "../../modules/enrolment/enrolment-service.js";
import type { EnrolmentView } from "../../modules/learning/learning-service.js";
import { AccessNote, Check, EmptyState, fmtDate, fmtDateTime, fmtNumber, Layout, ProgressBar, StatusBadge, TIER_LABEL, type FlashCode, type NavUser } from "./layout.js";

export function SignInPage(props: { providerLabel: string; returnTo: string; notice?: string | undefined; invite?: string | undefined }) {
  return (
    <Layout title="Sign in">
      <div className="grid grid-2">
        <section className="hero" aria-labelledby="signin-title">
          <h1 id="signin-title">Governance learning, wherever you are</h1>
          <p>Sign in with your TCGI account to continue your courses, track CPD and follow your organisation's learning plan.</p>
        </section>
        <section className="card" aria-labelledby="signin-card">
          <h2 id="signin-card">Sign in</h2>
          {props.notice ? <p className="flash flash-ok" role="status">{props.notice}</p> : null}
          <p>You'll continue to your organisation's secure sign-in page.</p>
          <form method="get" action="/auth/login">
            <input type="hidden" name="return_to" value={props.returnTo} />
            {props.invite ? <input type="hidden" name="invite" value={props.invite} /> : null}
            <button type="submit" className="button">Sign in</button>
          </form>
          <p className="muted small">Identity provider: <strong>{props.providerLabel}</strong></p>
        </section>
      </div>
    </Layout>
  );
}

export function DeniedPage(props: { reason: string }) {
  const msg: Record<string, string> = {
    person_inactive: "Your learning account is not active. Please contact TCGI support.",
    invite_invalid: "This invitation link has expired or has already been used. Ask your manager for a new invitation.",
    invite_identity_conflict: "This sign-in identity is already linked to a different learning account. Please contact TCGI support so we can merge them safely.",
    no_linked_account: "You signed in successfully, but no learning account is linked to this identity yet. If you were invited, use the link in your invitation. Otherwise contact TCGI support.",
  };
  return (
    <Layout title="Account not available">
      <div className="card">
        <h1>We couldn't open your learning account</h1>
        <p>{msg[props.reason] ?? msg.no_linked_account}</p>
        <p><a className="button secondary" href="/">Back to sign in</a></p>
      </div>
    </Layout>
  );
}

function CourseCard({ e, now }: { e: EnrolmentSummary; now: Date }) {
  const done = e.status === "completed";
  return (
    <li className="card course-card">
      <span className="tier">{TIER_LABEL[e.tier] ?? e.tier}</span>
      <h3><a href={`/learn/enrolments/${e.enrolmentId}`}>{e.courseTitle}</a></h3>
      <p className="muted small">{e.organisationName}</p>
      <ProgressBar done={e.placementsCompleted} total={e.placementsTotal} label={`Progress in ${e.courseTitle}`} />
      <div className="card-foot">
        {done ? <StatusBadge status="completed" label={`Completed ${fmtDate(e.completedAt)}`} /> : <AccessNote end={e.accessEnd} now={now} />}
        <a className="button small secondary" href={`/learn/enrolments/${e.enrolmentId}`}>
          {done ? "Review" : e.placementsStarted > 0 ? "Resume" : "Start"}<span className="visually-hidden">: {e.courseTitle}</span>
        </a>
      </div>
    </li>
  );
}

export function DashboardPage(props: { user: NavUser; enrolments: EnrolmentSummary[]; eligible: EligibleCourse[]; now: Date; cpdThisYear?: { total: number; unit: string | null }; flash?: FlashCode | null }) {
  const { user, enrolments, eligible, now } = props;
  const active = enrolments.filter((e) => e.status === "active");
  const completed = enrolments.filter((e) => e.status === "completed");
  const next = active.find((e) => e.placementsCompleted < e.placementsTotal) ?? active[0];
  const firstName = user.displayName.split(" ")[0];
  return (
    <Layout title="My learning" user={user} active="learn" flash={props.flash ?? null}>
      <h1>Welcome back, {firstName}</h1>
      {next ? (
        <section aria-labelledby="next-heading" className="hero">
          <p className="tier">Continue learning</p>
          <h2 id="next-heading">{next.courseTitle}</h2>
          <div className="hero-meta"><span>{TIER_LABEL[next.tier] ?? next.tier}</span><span>{next.organisationName}</span></div>
          <ProgressBar done={next.placementsCompleted} total={next.placementsTotal} label={`Progress in ${next.courseTitle}`} />
          {next.placementsStarted > 0 && next.placementsCompleted === 0 ? <p>You've started this course. Pick up where you left off.</p> : null}
          <a className="button" href={`/learn/enrolments/${next.enrolmentId}`}>{next.placementsStarted > 0 ? "Resume course" : "Start course"}</a>
        </section>
      ) : enrolments.length === 0 && eligible.length > 0 ? (
        <p className="lede">Your courses are ready. Enrol in one below to get started.</p>
      ) : null}

      <ul className="stats" aria-label="Your learning at a glance">
        <li className="stat"><span className="stat-value">{active.length}</span><span className="stat-label">In progress</span></li>
        <li className="stat"><span className="stat-value">{completed.length}</span><span className="stat-label">Completed</span></li>
        <li className="stat"><span className="stat-value">{eligible.length}</span><span className="stat-label">Available to start</span></li>
        <li className="stat">
          <span className="stat-value">{props.cpdThisYear ? fmtNumber(props.cpdThisYear.total) : "0"}</span>
          <span className="stat-label">CPD this year{props.cpdThisYear?.unit ? ` (${props.cpdThisYear.unit})` : ""}</span>
        </li>
      </ul>

      <section aria-labelledby="courses-heading">
        <div className="section-head"><h2 id="courses-heading">My courses</h2>{enrolments.length ? <span className="muted small">{enrolments.length} total</span> : null}</div>
        {enrolments.length === 0 ? (
          <EmptyState title="No courses yet"><p>When you enrol in a course it appears here with your progress.</p></EmptyState>
        ) : (
          <ul className="grid grid-3">{enrolments.map((e) => <CourseCard key={e.enrolmentId} e={e} now={now} />)}</ul>
        )}
      </section>

      <section aria-labelledby="available-heading">
        <h2 id="available-heading">Available to you</h2>
        {eligible.length === 0 ? (
          <EmptyState title="Nothing new to start"><p>Courses you purchase or that your organisation assigns to you appear here.</p></EmptyState>
        ) : (
          <ul className="grid grid-3">
            {eligible.map((c) => (
              <li key={c.courseId} className="card course-card">
                <span className="tier">{TIER_LABEL[c.tier] ?? c.tier}</span>
                <h3>{c.title}</h3>
                <AccessNote end={c.accessEnd} now={now} />
                <div className="card-foot">
                  <form method="post" action={`/learn/courses/${c.courseId}/enrol`}>
                    <input type="hidden" name="_csrf" value={user.csrfToken} />
                    <button type="submit" className="button small">Enrol in {c.title}</button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Layout>
  );
}

export function EnrolmentPage(props: { user: NavUser; view: EnrolmentView; now: Date; flash?: FlashCode | null }) {
  const { user, view, now } = props;
  const required = view.placements.filter((p) => p.required);
  const done = required.filter((p) => p.firstCompletedAt).length;
  const next = view.placements.find((p) => !p.firstCompletedAt);
  const ended = view.accessEnd !== null && new Date(view.accessEnd) <= now;
  const launchForm = (placementId: string, label: string, title: string, primary: boolean) => (
    <form method="post" action={`/learn/enrolments/${view.enrolmentId}/placements/${placementId}/launch`}>
      <input type="hidden" name="_csrf" value={user.csrfToken} />
      <button type="submit" className={`button${primary ? "" : " secondary small"}`} disabled={ended}>
        {label}<span className="visually-hidden">: {title}</span>
      </button>
    </form>
  );
  return (
    <Layout title={view.courseTitle} user={user} active="learn" flash={props.flash ?? null}>
      <p className="breadcrumb"><a href="/learn">My learning</a> › <span aria-current="page">{view.courseTitle}</span></p>
      <section className="hero" aria-labelledby="course-title">
        <span className="tier">{TIER_LABEL[view.courseTier] ?? view.courseTier}</span>
        <h1 id="course-title">{view.courseTitle}</h1>
        <div className="hero-meta"><span>{view.organisationName}</span><span>Course version {view.revisionNo}</span></div>
        <ProgressBar done={done} total={required.length} label={`Progress in ${view.courseTitle}`} />
        {view.status === "completed" ? (
          <p><strong>Course completed on {fmtDate(view.completedAt)}.</strong></p>
        ) : next && !ended ? (
          launchForm(next.placementId, next.started ? "Resume where you left off" : "Start the first lesson", next.title, true)
        ) : null}
      </section>

      <div className="grid grid-2">
        <div>
          <h2>Lessons</h2>
          <ol className="steps lesson-list">
            {view.placements.map((p, i) => {
              const isDone = !!p.firstCompletedAt;
              const isCurrent = !isDone && next?.placementId === p.placementId;
              return (
                <li key={p.placementId} className={`step${isDone ? " done" : ""}${isCurrent ? " current" : ""}`}>
                  <span className="step-icon" aria-hidden="true">{isDone ? <Check /> : i + 1}</span>
                  <div className="card step-body">
                    <div>
                      <h3>{p.title}</h3>
                      <div className="step-meta">
                        <StatusBadge status={p.completion} />
                        {p.success !== "unknown" ? <StatusBadge status={p.success} /> : null}
                        {p.scoreRaw !== null ? <span>Score reported by the lesson: {Number(p.scoreRaw)}</span> : null}
                        {!p.required ? <span>Optional</span> : null}
                      </div>
                      {p.firstCompletedAt ? <p className="muted small">First completed {fmtDateTime(p.firstCompletedAt)}</p> : null}
                    </div>
                    {launchForm(p.placementId, isDone ? "Review lesson" : p.started ? "Resume lesson" : "Start lesson", p.title, false)}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
        <aside aria-labelledby="about-heading">
          <h2 id="about-heading">About your access</h2>
          <div className="card">
            <dl className="meta">
              <dt>Status</dt><dd><StatusBadge status={view.status} /></dd>
              <dt>Access</dt><dd><AccessNote end={view.accessEnd} now={now} /></dd>
              <dt>Provided by</dt><dd>{view.organisationName}</dd>
            </dl>
            {ended ? <p className="flash flash-warn">Your access to this course has ended. Your progress is kept. Contact support if you need an extension.</p> : null}
            <p className="muted small">Scores shown are reported by the lesson content.</p>
          </div>
        </aside>
      </div>
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
  const roleLabel: Record<string, string> = { tcgi_admin: "TCGI administrator", enterprise_manager: "Team manager" };
  return (
    <Layout title="My account" user={props.user} active="account">
      <h1>My account</h1>
      <p className="lede">How TCGI Learning recognises you. Your sign-in identity is the key. Your email address is only used to contact you.</p>
      <div className="grid grid-2">
        <section className="card" aria-labelledby="profile-h">
          <h2 id="profile-h">Profile</h2>
          <dl className="meta">
            <dt>Name</dt><dd>{person.display_name}</dd>
            <dt>Email</dt><dd>{person.primary_email ?? "—"} <span className="muted small">{person.email_verified ? "(verified by identity provider)" : "(not verified)"}</span></dd>
            <dt>Status</dt><dd><StatusBadge status={person.status} /></dd>
            <dt>LMS person ID</dt><dd><code>{person.id}</code></dd>
          </dl>
          <p className="muted small">Name and email are updated from your identity provider each time you sign in.</p>
        </section>
        <section className="card" aria-labelledby="orgs-h">
          <h2 id="orgs-h">Organisations and roles</h2>
          <ul>{memberships.map((m) => <li key={m.name}>{m.name} ({m.kind === "tcgi_direct" ? "TCGI direct learner" : "enterprise"}) · {m.status}</li>)}</ul>
          {grants.length === 0 ? <p>Learner (no additional roles).</p> : (
            <ul>{grants.map((g, i) => <li key={i}>{roleLabel[g.role] ?? g.role} · {g.scope_type === "platform" ? "TCGI platform" : g.org_name}</li>)}</ul>
          )}
        </section>
      </div>
      <h2>Sign-in identities</h2>
      <div className="table-scroll">
        <table>
          <caption className="visually-hidden">Identity links</caption>
          <thead><tr><th scope="col">Issuer</th><th scope="col">Subject</th><th scope="col">Linked via</th><th scope="col">Last sign-in</th></tr></thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.issuer + l.subject}><td><code>{l.issuer}</code></td><td><code>{l.subject}</code></td><td>{l.linked_via}</td><td>{fmtDateTime(l.last_login_at)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
}

export function InvitePage(props: { orgName: string | null; token: string; providerLabel: string }) {
  return (
    <Layout title="Your invitation">
      <div className="card">
        {props.orgName ? (
          <>
            <h1>You're invited to learn with {props.orgName}</h1>
            <p>Sign in with your TCGI account to accept. If you already learn with TCGI, use the same account, and your existing courses and this invitation are combined.</p>
            <form method="get" action="/auth/login">
              <input type="hidden" name="invite" value={props.token} />
              <input type="hidden" name="return_to" value="/learn?flash=invite-accepted" />
              <button type="submit" className="button">Accept and sign in</button>
            </form>
            <p className="muted small">Identity provider: {props.providerLabel}</p>
          </>
        ) : (
          <>
            <h1>This invitation isn't valid</h1>
            <p>It may have expired or already been used. Ask your manager for a new invitation.</p>
          </>
        )}
      </div>
    </Layout>
  );
}
