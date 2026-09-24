import type { CompletionStatus, SuccessStatus } from "../../db/schema.js";

/**
 * Mapping between SCORM CMI data (as committed by the scorm-again run-time API) and our normalised
 * ProgressState. The mapping is deliberately explicit and unit-tested.
 *
 * PROVISIONAL (DEC-16 / DEC-19): SCORM 1.2 "failed" is mapped to completion "unknown" + success "failed",
 * and 1.2 "browsed" to "incomplete". Aishwarya must confirm how these statuses count towards completion.
 */
export interface NormalisedCmi {
  completion?: CompletionStatus;
  success?: SuccessStatus;
  scoreRaw?: number | null;
  scoreMin?: number | null;
  scoreMax?: number | null;
  scoreScaled?: number | null;
  location?: string;
  suspendData?: string;
  exit?: string;
  totalTime?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
function num(v: unknown): number | null | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Accepts {cmi:{...}} or a bare cmi object. */
function cmiRoot(payload: unknown): Obj {
  if (isObj(payload) && isObj(payload.cmi)) return payload.cmi;
  if (isObj(payload)) return payload;
  return {};
}

export function normaliseScorm12(payload: unknown): NormalisedCmi {
  const cmi = cmiRoot(payload);
  const core = isObj(cmi.core) ? cmi.core : {};
  const out: NormalisedCmi = {};
  const status = str(core.lesson_status);
  switch (status) {
    case "passed": out.completion = "completed"; out.success = "passed"; break;
    case "completed": out.completion = "completed"; break;
    case "failed": out.completion = "unknown"; out.success = "failed"; break;
    case "incomplete":
    case "browsed": out.completion = "incomplete"; break;
    case "not attempted": out.completion = "not_attempted"; break;
    default: break;
  }
  const score = isObj(core.score) ? core.score : {};
  const raw = num(score.raw); if (raw !== undefined) out.scoreRaw = raw;
  const min = num(score.min); if (min !== undefined) out.scoreMin = min;
  const max = num(score.max); if (max !== undefined) out.scoreMax = max;
  const loc = str(core.lesson_location); if (loc !== undefined) out.location = loc;
  const sd = str(cmi.suspend_data); if (sd !== undefined) out.suspendData = sd;
  const exit = str(core.exit); if (exit !== undefined) out.exit = exit;
  const tt = str(core.total_time); if (tt !== undefined) out.totalTime = tt;
  return out;
}

export function normaliseScorm2004(payload: unknown): NormalisedCmi {
  const cmi = cmiRoot(payload);
  const out: NormalisedCmi = {};
  const cs = str(cmi.completion_status);
  if (cs === "completed" || cs === "incomplete" || cs === "unknown") out.completion = cs;
  else if (cs === "not attempted") out.completion = "not_attempted";
  const ss = str(cmi.success_status);
  if (ss === "passed" || ss === "failed" || ss === "unknown") out.success = ss;
  const score = isObj(cmi.score) ? cmi.score : {};
  const raw = num(score.raw); if (raw !== undefined) out.scoreRaw = raw;
  const min = num(score.min); if (min !== undefined) out.scoreMin = min;
  const max = num(score.max); if (max !== undefined) out.scoreMax = max;
  const scaled = num(score.scaled); if (scaled !== undefined) out.scoreScaled = scaled;
  const loc = str(cmi.location); if (loc !== undefined) out.location = loc;
  const sd = str(cmi.suspend_data); if (sd !== undefined) out.suspendData = sd;
  const exit = str(cmi.exit); if (exit !== undefined) out.exit = exit;
  const tt = str(cmi.total_time); if (tt !== undefined) out.totalTime = tt;
  return out;
}

export function normalise(edition: "1.2" | "2004", payload: unknown): NormalisedCmi {
  return edition === "1.2" ? normaliseScorm12(payload) : normaliseScorm2004(payload);
}

export interface StoredProgress {
  completion_status: CompletionStatus;
  success_status: SuccessStatus;
  score_raw: string | null;
  score_min: string | null;
  score_max: string | null;
  score_scaled: string | null;
  location: string | null;
  suspend_data: string | null;
  exit_mode: string | null;
}

const toCmiNumber = (v: string | null) => (v === null ? "" : String(Number(v)));

/**
 * The CMI state handed to the run-time API on relaunch, so the content resumes where it stopped. `entry`
 * is "resume" only if the previous session exited with "suspend" (SCORM 1.2 RTE 3.4.4.1 and the 2004
 * cmi.entry rules). The object is the *inner* CMI tree (no "cmi" wrapper), which is the shape expected by
 * scorm-again's loadFromJSON().
 */
export function resumeState(edition: "1.2" | "2004", p: StoredProgress | null, learner: { id: string; name: string }): Obj {
  const resuming = p?.exit_mode === "suspend";
  if (edition === "1.2") {
    const lessonStatus =
      !p ? "not attempted"
      : p.success_status === "passed" ? "passed"
      : p.success_status === "failed" ? "failed"
      : p.completion_status === "completed" ? "completed"
      : p.completion_status === "incomplete" ? "incomplete"
      : "not attempted";
    return {
        core: {
          student_id: learner.id,
          student_name: learner.name,
          lesson_status: lessonStatus,
          lesson_location: p?.location ?? "",
          entry: resuming ? "resume" : p ? "" : "ab-initio",
          score: { raw: toCmiNumber(p?.score_raw ?? null), min: toCmiNumber(p?.score_min ?? null), max: toCmiNumber(p?.score_max ?? null) },
        },
        suspend_data: p?.suspend_data ?? "",
    };
  }
  return {
      learner_id: learner.id,
      learner_name: learner.name,
      completion_status: p ? (p.completion_status === "not_attempted" ? "not attempted" : p.completion_status) : "unknown",
      success_status: p?.success_status ?? "unknown",
      location: p?.location ?? "",
      entry: resuming ? "resume" : p ? "" : "ab-initio",
      suspend_data: p?.suspend_data ?? "",
      score: { raw: toCmiNumber(p?.score_raw ?? null), min: toCmiNumber(p?.score_min ?? null), max: toCmiNumber(p?.score_max ?? null), scaled: toCmiNumber(p?.score_scaled ?? null) },
  };
}

/** SCORM data-model limits for suspend_data. Enforced server-side as defence in depth. */
export const SUSPEND_DATA_LIMIT = { "1.2": 4096, "2004": 64000 } as const;
