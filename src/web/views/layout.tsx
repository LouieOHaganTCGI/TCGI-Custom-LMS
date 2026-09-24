import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export interface NavUser {
  displayName: string;
  isAdmin: boolean;
  csrfToken: string;
}

const dateFmt = new Intl.DateTimeFormat("en-IE", { dateStyle: "medium", timeZone: "Europe/Dublin" });
const dateTimeFmt = new Intl.DateTimeFormat("en-IE", { dateStyle: "medium", timeStyle: "medium", timeZone: "Europe/Dublin" });
export const fmtDate = (d: Date | string | null | undefined) => (d ? dateFmt.format(new Date(d)) : "—");
export const fmtDateTime = (d: Date | string | null | undefined) => (d ? dateTimeFmt.format(new Date(d)) : "—");

export function render(node: ReactNode): string {
  return "<!doctype html>" + renderToStaticMarkup(node);
}

export function Layout(props: { title: string; user?: NavUser | null; children: ReactNode; stylesheet?: string }) {
  const { title, user, children } = props;
  return (
    <html lang="en-IE">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${title} · TCGI Learning`}</title>
        <link rel="stylesheet" href={props.stylesheet ?? "/assets/app.css"} />
      </head>
      <body>
        <a className="skip-link" href="#main">Skip to main content</a>
        <header className="site-header">
          <div className="wrap header-inner">
            <a className="brand" href="/">TCGI Learning</a>
            {user ? (
              <nav aria-label="Main">
                <ul className="nav-list">
                  <li><a href="/learn">My learning</a></li>
                  <li><a href="/me">My account</a></li>
                  {user.isAdmin ? <li><a href="/admin">Admin</a></li> : null}
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
          {children}
        </main>
        <footer className="site-footer wrap">
          <p>TCGI LMS · Phase B build · Not for production use</p>
        </footer>
      </body>
    </html>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const label: Record<string, string> = {
    not_attempted: "Not started",
    incomplete: "In progress",
    completed: "Completed",
    unknown: "Unknown",
    active: "Active",
    expired: "Expired",
    withdrawn: "Withdrawn",
    passed: "Passed",
    failed: "Failed",
    pending: "Pending",
    delivered: "Delivered",
    dead: "Dead-lettered",
  };
  return <span className={`badge badge-${status}`}>{label[status] ?? status}</span>;
}

export function ErrorPage(props: { status: number; title: string; message: string; user?: NavUser | null }) {
  return (
    <Layout title={props.title} user={props.user ?? null}>
      <h1>{props.title}</h1>
      <p>{props.message}</p>
      <p><a href="/learn">Go to my learning</a></p>
    </Layout>
  );
}
