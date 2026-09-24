import { renderToStaticMarkup } from "react-dom/server";

/**
 * The player shell on the content origin. It hosts the scorm-again run-time API object (window.API or
 * window.API_1484_11) and frames the package, which is same-origin so SCORM API discovery works.
 * No inline script, and all configuration is passed as data attributes.
 */
export function renderPlayer(p: { title: string; edition: "1.2" | "2004"; base: string; launchPath: string; exitUrl: string }): string {
  const vendor = p.edition === "1.2" ? "/static/vendor/scorm12.min.js" : "/static/vendor/scorm2004.min.js";
  return (
    "<!doctype html>" +
    renderToStaticMarkup(
      <html lang="en-IE">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{`${p.title} · TCGI Learning`}</title>
          <link rel="stylesheet" href="/static/player.css" />
          <script src={vendor} defer />
          <script src="/static/player.js" defer />
        </head>
        <body>
          <div id="player" data-edition={p.edition} data-base={p.base} data-launch={p.launchPath} data-exit={p.exitUrl}>
            <header className="player-bar">
              <h1 className="player-title">{p.title}</h1>
              <p id="player-status" className="player-status" role="status" aria-live="polite">Loading lesson…</p>
              <button id="player-exit" type="button" className="player-exit">Save and return to course</button>
            </header>
            <iframe id="player-frame" title={`Lesson: ${p.title}`} className="player-frame" />
          </div>
        </body>
      </html>,
    )
  );
}
