import { describe, expect, it } from "vitest";
import { normaliseScorm12, normaliseScorm2004, resumeState } from "../../src/modules/learning/cmi.js";

// The mapping follows SCORM 1.2 RTE and SCORM 2004 RTE data-model semantics. Provisional choices (1.2
// "failed" and "browsed") are flagged in cmi.ts for Aishwarya's confirmation (DEC-16 / DEC-19).
describe("SCORM 1.2 normalisation", () => {
  it.each([
    ["passed", "completed", "passed"],
    ["completed", "completed", undefined],
    ["failed", "unknown", "failed"],
    ["incomplete", "incomplete", undefined],
    ["browsed", "incomplete", undefined],
    ["not attempted", "not_attempted", undefined],
  ])("lesson_status %s → completion %s, success %s", (status, completion, success) => {
    const n = normaliseScorm12({ cmi: { core: { lesson_status: status } } });
    expect(n.completion).toBe(completion);
    expect(n.success).toBe(success);
  });

  it("maps score, location, suspend_data and exit, and treats an empty score as null (not 0)", () => {
    const n = normaliseScorm12({ cmi: { core: { score: { raw: "", min: "0", max: "100" }, lesson_location: "p3", exit: "suspend" }, suspend_data: "abc" } });
    expect(n).toMatchObject({ scoreRaw: null, scoreMin: 0, scoreMax: 100, location: "p3", exit: "suspend", suspendData: "abc" });
  });

  it("ignores fields that are absent, so partial commits don't erase stored state", () => {
    expect(normaliseScorm12({ cmi: { core: {} } })).toEqual({});
  });
});

describe("SCORM 2004 normalisation", () => {
  it("keeps completion and success independent", () => {
    expect(normaliseScorm2004({ cmi: { completion_status: "completed", success_status: "failed" } })).toMatchObject({ completion: "completed", success: "failed" });
    expect(normaliseScorm2004({ cmi: { completion_status: "not attempted" } }).completion).toBe("not_attempted");
    expect(normaliseScorm2004({ cmi: { score: { scaled: "0.75" } } }).scoreScaled).toBe(0.75);
  });
  it("rejects non-numeric scores rather than storing garbage", () => {
    expect(normaliseScorm2004({ cmi: { score: { raw: "abc" } } }).scoreRaw).toBeUndefined();
  });
});

describe("resume state", () => {
  const base = { completion_status: "incomplete" as const, success_status: "unknown" as const, score_raw: null, score_min: null, score_max: null, score_scaled: null, location: "p2", suspend_data: "{\"screen\":2}" };
  it("first launch is ab-initio with empty suspend data", () => {
    expect(resumeState("1.2", null, { id: "x", name: "n" })).toMatchObject({ core: { entry: "ab-initio", lesson_status: "not attempted" }, suspend_data: "" });
    expect(resumeState("2004", null, { id: "x", name: "n" })).toMatchObject({ entry: "ab-initio", completion_status: "unknown" });
  });
  it("after exit=suspend, entry is 'resume' and location and suspend data are restored", () => {
    expect(resumeState("1.2", { ...base, exit_mode: "suspend" }, { id: "x", name: "n" })).toMatchObject({ core: { entry: "resume", lesson_location: "p2" }, suspend_data: "{\"screen\":2}" });
    expect(resumeState("2004", { ...base, exit_mode: "suspend" }, { id: "x", name: "n" })).toMatchObject({ entry: "resume", location: "p2" });
  });
  it("after a normal exit, entry is empty (a new session of the same attempt)", () => {
    expect(resumeState("2004", { ...base, exit_mode: "" }, { id: "x", name: "n" })).toMatchObject({ entry: "" });
  });
  it("gives content only an opaque learner id and a display name (no email)", () => {
    const s = JSON.stringify(resumeState("1.2", null, { id: "3a000000-0000-4000-8000-000000000001", name: "Aoife" }));
    expect(s).not.toMatch(/@/);
  });
});
