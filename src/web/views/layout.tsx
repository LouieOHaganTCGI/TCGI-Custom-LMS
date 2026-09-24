import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export interface NavUser {
  displayName: string;
  isAdmin: boolean;
  isManager: boolean;
  csrfToken: string;
}

export type NavKey = "learn" | "cpd" | "account" | "manage" | "admin" | "none";

const dateFmt = new Intl.DateTimeFormat("en-IE", { dateStyle: "medium", timeZone: "Europe/Dublin" });
const dateTimeFmt = new Intl.DateTimeFormat("en-IE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Dublin" });
export const fmtDate = (d: Date | string | null | undefined) => (d ? dateFmt.format(new Date(d)) : "—");
export const fmtDateTime = (d: Date | string | null | undefined) => (d ? dateTimeFmt.format(new Date(d)) : "—");
export const fmtNumber = (n: number | string | null | undefined) =>
  n === null || n === undefined ? "—" : new Intl.NumberFormat("en-IE", { maximumFractionDigits: 2 }).format(Number(n));

export function render(node: ReactNode): string {
  return "<!doctype html>" + renderToStaticMarkup(node);
}

/**
 * Flash messages are passed as a short code (never free text from the request), so a crafted URL or
 * cookie can't inject content.
 */
export type FlashCode = keyof typeof FLASH_MESSAGES;
export const FLASH_MESSAGES = {
  enrolled: { kind: "ok", text: "You're enrolled. Start with the first lesson below." },
  "lesson-saved": { kind: "ok", text: "Your progress has been saved." },
  "invite-created": { kind: "ok", text: "Invitation created. Copy the link below and send it to the learner." },
  "seat-assigned": { kind: "ok", text: "Course assigned. The learner can now see it in My learning." },
  "invite-accepted": { kind: "ok", text: "Welcome! Your account is now linked. Your assigned courses are below." },
  "org-created": { kind: "ok", text: "Organisation created." },
  "agreement-created": { kind: "ok", text: "Agreement created." },
  "manager-granted": { kind: "ok", text: "Manager role granted." },
  "seat-released": { kind: "ok", text: "Seat released. The learner's history is kept." },
  "mapping-created": { kind: "ok", text: "Product mapping created." },
  "course-updated": { kind: "ok", text: "Course settings saved." },
  "event-reprocessed": { kind: "ok", text: "Event reprocessed." },
} as const satisfies Record<string, { kind: "ok" | "warn" | "error"; text: string }>;

export function isFlashCode(v: unknown): v is FlashCode {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(FLASH_MESSAGES, v);
}

export function Layout(props: { title: string; user?: NavUser | null; children: ReactNode; active?: NavKey; flash?: FlashCode | null; wide?: boolean }) {
  const { title, user, children, active = "none" } = props;
  const cur = (k: NavKey) => (active === k ? ({ "aria-current": "page" } as const) : {});
  const flash = props.flash ? FLASH_MESSAGES[props.flash] : null;
  return (
    <html lang="en-IE">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${title} · TCGI Learning`}</title>
        <link rel="stylesheet" href="/assets/app.css" />
        <script src="/assets/app.js" defer />
      </head>
      <body>
        <a className="skip-link" href="#main">Skip to main content</a>
        <header className="site-header">
          <div className="wrap header-inner">
            <a className="brand" href="/"><span className="brand-mark" aria-hidden="true">TCGI</span>TCGI Learning</a>
            {user ? (
              <nav aria-label="Main">
                <ul className="nav-list">
                  <li><a href="/learn" {...cur("learn")}>My learning</a></li>
                  <li><a href="/cpd" {...cur("cpd")}>CPD</a></li>
                  {user.isManager ? <li><a href="/manage" {...cur("manage")}>Manage team</a></li> : null}
                  {user.isAdmin ? <li><a href="/admin" {...cur("admin")}>Admin</a></li> : null}
                  <li><a href="/me" {...cur("account")}>My account</a></li>
                  <li>
                    <form method="post" action="/auth/logout" className="inline-form">
                      <input type="hidden" name="_csrf" value={user.csrfToken} />
                      <button type="submit" className="link-button">Sign out</button>
                    </form>
                  </li>
                </ul>
              </nav>
            ) : null}
          </div>
        </header>
        <main id="main" className="wrap" tabIndex={-1}>
          {flash ? <p className={`flash flash-${flash.kind}`} role="status">{flash.text}</p> : null}
          {children}
        </main>
        <footer className="site-footer wrap">
          <p>TCGI Learning · pre-production build · synthetic data only</p>
        </footer>
      </body>
    </html>
  );
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const text: Record<string, string> = {
    not_attempted: "Not started", incomplete: "In progress", completed: "Completed", unknown: "Unknown", active: "Active", expired: "Expired",
    withdrawn: "Withdrawn", passed: "Passed", failed: "Failed", pending: "Pending", delivered: "Delivered", dead: "Dead-lettered",
    received: "Received", processed: "Processed", held: "Held for review", rejected: "Rejected", revoked: "Revoked", suspended: "Suspended",
    invited: "Invited", ended: "Ended", allocated: "Seat active", released: "Seat released",
  };
  const cls = status === "allocated" ? "active-seat" : status;
  return <span className={`badge badge-${cls}`}>{label ?? text[status] ?? status}</span>;
}

export function ProgressBar({ done, total, label }: { done: number; total: number; label: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div>
      <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${pct}%`}>
        <span className={`progress-fill w-${Math.round(pct / 10) * 10}`} />
      </div>
      <p className="progress-label">{total === 0 ? "No lessons yet" : `${done} of ${total} lessons completed · ${pct}%`}</p>
    </div>
  );
}

/** "Access until …", highlighted when it ends within 30 days, and shown as ended when past. */
export function AccessNote({ end, now = new Date() }: { end: Date | null; now?: Date }) {
  if (!end) return <p className="access-note">No access end date</p>;
  const days = Math.ceil((new Date(end).getTime() - now.getTime()) / 86_400_000);
  if (days <= 0) return <p className="access-note ended">Access ended {fmtDate(end)}</p>;
  if (days <= 30) return <p className="access-note soon">Access ends in {days} day{days === 1 ? "" : "s"} ({fmtDate(end)})</p>;
  return <p className="access-note">Access until {fmtDate(end)}</p>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Check() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ErrorPage(props: { status: number; title: string; message: string; user?: NavUser | null }) {
  return (
    <Layout title={props.title} user={props.user ?? null}>
      <div className="card">
        <h1>{props.title}</h1>
        <p>{props.message}</p>
        <p><a className="button secondary" href="/learn">Go to my learning</a></p>
      </div>
    </Layout>
  );
}

export const TIER_LABEL: Record<string, string> = {
  microlesson: "Micro-lesson",
  foundation: "Foundation course",
  professional_certificate: "Professional Certificate",
  advanced_certificate: "Advanced Professional Certificate",
  diploma: "Diploma",
};
