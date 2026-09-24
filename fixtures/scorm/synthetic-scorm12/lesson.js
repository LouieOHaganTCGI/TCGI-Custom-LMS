/* Synthetic SCORM content: works against SCORM 1.2 (window.API) or 2004 (window.API_1484_11). */
(function () {
  "use strict";
  var SCREENS = 3;
  function find(name) {
    var w = window, n = 0;
    while (w && n < 10) { if (w[name]) return w[name]; if (w.parent === w) break; w = w.parent; n++; }
    return null;
  }
  var a04 = find("API_1484_11");
  var a12 = a04 ? null : find("API");
  var v = a04 ? "2004" : a12 ? "1.2" : null;
  var statusEl = document.getElementById("api-status");
  if (!v) { statusEl.textContent = "No SCORM API found."; return; }
  function get(k12, k04) { return v === "1.2" ? a12.LMSGetValue(k12) : a04.GetValue(k04); }
  function set(k12, k04, val) { return v === "1.2" ? a12.LMSSetValue(k12, val) : a04.SetValue(k04, val); }
  function commit() { return v === "1.2" ? a12.LMSCommit("") : a04.Commit(""); }
  function finish() { return v === "1.2" ? a12.LMSFinish("") : a04.Terminate(""); }

  var ok = v === "1.2" ? a12.LMSInitialize("") : a04.Initialize("");
  statusEl.textContent = "SCORM " + v + " API initialised: " + ok;
  var entry = get("cmi.core.entry", "cmi.entry");
  var sd = get("cmi.suspend_data", "cmi.suspend_data");
  var state = { screen: 1 };
  try { if (sd) state = JSON.parse(sd); } catch (e) { /* ignore malformed */ }
  if (entry === "resume") document.getElementById("resume-note").hidden = false;

  function render() {
    document.getElementById("screen").textContent = "Screen " + state.screen + " of " + SCREENS;
    document.getElementById("body").textContent = "Synthetic content for screen " + state.screen + ".";
  }
  function save() {
    set("cmi.core.lesson_location", "cmi.location", "screen-" + state.screen);
    set("cmi.suspend_data", "cmi.suspend_data", JSON.stringify(state));
  }
  render();
  if (get("cmi.core.lesson_status", "cmi.completion_status") === "not attempted" || get("cmi.core.lesson_status", "cmi.completion_status") === "unknown") {
    set("cmi.core.lesson_status", "cmi.completion_status", "incomplete");
    commit();
  }

  document.getElementById("next").addEventListener("click", function () {
    state.screen = Math.min(SCREENS, state.screen + 1);
    render(); save(); commit();
  });
  document.getElementById("complete").addEventListener("click", function () {
    save();
    set("cmi.core.score.min", "cmi.score.min", "0");
    set("cmi.core.score.max", "cmi.score.max", "100");
    set("cmi.core.score.raw", "cmi.score.raw", "80");
    if (v === "1.2") { a12.LMSSetValue("cmi.core.lesson_status", "passed"); }
    else { a04.SetValue("cmi.score.scaled", "0.8"); a04.SetValue("cmi.completion_status", "completed"); a04.SetValue("cmi.success_status", "passed"); }
    commit();
    statusEl.textContent = "Lesson completed and passed (score 80).";
  });
  document.getElementById("suspend").addEventListener("click", function () {
    save();
    set("cmi.core.exit", "cmi.exit", "suspend");
    commit(); finish();
    statusEl.textContent = "Progress saved. You can close this lesson.";
  });
})();
