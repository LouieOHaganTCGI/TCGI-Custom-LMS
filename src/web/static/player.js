/*
 * TCGI LMS SCORM player shell (content origin). It hosts the scorm-again run-time API (MIT) as window.API
 * (SCORM 1.2) or window.API_1484_11 (SCORM 2004), restores the saved CMI state, then frames the package.
 * The package is same-origin, so standard SCORM API discovery (walking window.parent) finds the API.
 * Commits go to /a/<attempt>/runtime/commit and are authorised by the attempt-scoped launch cookie.
 */
(function () {
  "use strict";
  var root = document.getElementById("player");
  var statusEl = document.getElementById("player-status");
  var frame = document.getElementById("player-frame");
  var exitBtn = document.getElementById("player-exit");
  var edition = root.getAttribute("data-edition");
  var base = root.getAttribute("data-base");
  var launch = root.getAttribute("data-launch");
  var exitUrl = root.getAttribute("data-exit");
  var api = null;
  var finished = false;

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function finish() {
    if (!api || finished) return;
    finished = true;
    try {
      if (edition === "1.2") api.LMSFinish(""); else api.Terminate("");
    } catch (e) {
      /* the content may already have finished */
    }
  }

  exitBtn.addEventListener("click", function () {
    // Only finish the session if the content hasn't already done so. The content is responsible for cmi.exit.
    finish();
    window.location.assign(exitUrl);
  });

  fetch(base + "/runtime/state", { credentials: "same-origin", headers: { accept: "application/json" } })
    .then(function (res) {
      if (!res.ok) throw new Error("state request failed: " + res.status);
      return res.json();
    })
    .then(function (state) {
      var Api = edition === "1.2" ? window.Scorm12API : window.Scorm2004API;
      if (!Api) throw new Error("SCORM runtime failed to load");
      api = new Api({
        lmsCommitUrl: base + "/runtime/commit",
        autocommit: true,
        autocommitSeconds: 10,
        dataCommitFormat: "json",
        fetchMode: "same-origin",
        // The terminate commit uses sendBeacon. It's same-origin, so a JSON content type is allowed.
        terminationCommitContentType: "application/json",
        xhrWithCredentials: false,
        logLevel: 4,
      });
      api.loadFromJSON(state.cmi);
      if (edition === "1.2") window.API = api; else window.API_1484_11 = api;
      var finishEvent = edition === "1.2" ? "LMSFinish" : "Terminate";
      api.on(edition === "1.2" ? "LMSInitialize" : "Initialize", function () {
        setStatus("Lesson in progress. Your progress is saved automatically.");
      });
      api.on(finishEvent, function () {
        finished = true;
        setStatus("Your progress has been saved. You can return to your course.");
      });
      api.on("CommitError", function () {
        setStatus("We could not save your latest progress. Check your connection. We will keep trying.");
      });
      frame.src = launch;
    })
    .catch(function (err) {
      setStatus("This lesson could not be started. Please return to your course and try again.");
      if (window.console) console.error(err);
    });

  // Best effort: finish the session when the page is being hidden or closed (unverified on mobile, test R8).
  window.addEventListener("pagehide", finish);
})();
