# 06 — Migration spike: Brightspace progress and SCORM suspend data

Status: **Plan for approval.** Scheduled for D3–D4 (2–27 Nov 2026). Owners: Boris (technical) and Aishwarya (academic ground truth). The Product/Ops decision-maker (Aayushi/Andre, TBC) owns the fallback policy (DEC-28).

## 1. Question the spike answers

For a representative pilot course, **can we extract each active learner's granular SCORM runtime state from Brightspace in a usable form, and does our chosen runtime resume the same Rise package from that state?** If not, what is the safest transfer we *can* verify?

We don't assume the answer. The brief (§7) and the operating rules forbid any migration guarantee before this evidence exists.

## 2. Why this is hard (hypotheses to test)

| H | Hypothesis | Why it matters |
|---|---|---|
| H1 | Brightspace exposes SCORM runtime data (status, score, location, `suspend_data`) through its data export or API features (for example Brightspace Data Sets, or the Valence API). **Which ones, with which fields, and whether `suspend_data` comes through complete and untruncated, is unverified.** | If `suspend_data` isn't exportable, resuming mid-lesson is impossible. |
| H2 | Rise `suspend_data` can be resumed **only by the identical package build**. A re-published Rise export may change internal IDs. | We must reuse the exact packages deployed in Brightspace, and prove which build that is (hash comparison). |
| H3 | Brightspace user identifiers can be mapped to the miniOrange subject (via SSO configuration, org-defined ID, or username), not just by email. | Needed for ID-01 and ID-03 without email-based merging. |
| H4 | Non-SCORM progress (native quizzes, grades, topic completion, release conditions, awards) exists for some pilot courses. | That needs a separate mapping, or a fallback. |
| H5 | SCORM 1.2 packages may be at or near the 4,096-character `suspend_data` limit. | This affects whether the stored data is complete. |

## 3. Preconditions (the spike doesn't start without them)

1. **DEC-09 approved:** a data-handling route for real learner data. Extraction runs **inside a TCGI-controlled environment** by a TCGI-authorised person. Only pseudonymised or structural outputs reach the engineering team and any coding tool. Raw `suspend_data` from real learners is treated as personal data, because Rise quiz or free-text answers may be embedded in it.
2. **DEC-14:** the spike course is chosen (ideally the intended pilot B2C course and one enterprise course), with ≥ 1 SCORM 1.2 and ≥ 1 SCORM 2004 package.
3. Brightspace admin or data-export access for the TCGI person running the extraction, and permission to create **synthetic test learner accounts** in Brightspace (the contract's terms permitting).
4. The D2 runtime evaluation harness is available (for the injection test, R11).
5. The source Rise exports for the spike course are available for hash comparison (DEC-03 and DEC-04).

## 4. Method

### Step 1 — Ground truth with synthetic learners (no personal data)

- Create **5 synthetic learners** in Brightspace, enrolled in the spike course.
- Drive each to a scripted, recorded state:
  - L1: not started
  - L2: part way through lesson 1 (a known screen)
  - L3: lesson 1 complete, lesson 2 part way
  - L4: quiz attempted and failed once
  - L5: course complete and passed
- Record the expected state (screenshots, and the CMI values captured with a debugging proxy or browser devtools in the test session).

### Step 2 — Extraction methods, tried in order and recorded

| M | Method | What to record |
|---|---|---|
| M-a | Brightspace Data Sets or Data Hub SCORM-related data sets | Which data sets exist in TCGI's instance and entitlement. Fields. Is `suspend_data` present? Length? Complete? Is `location` present? Attempt granularity? Refresh latency? |
| M-b | Brightspace APIs (Valence) | Whether any endpoint returns per-user SCORM runtime state. Authentication model. Rate limits |
| M-c | A formal request to D2L support or services for a runtime-state export | Feasibility, format, cost (to Finance), lead time. **This counts as an external request, so it needs approval before it's sent** |
| M-d | The course export or package | Confirm it contains the deployed package builds (for H2). User data isn't expected here |

Also for each method: user identifier fields (for H3), and native quiz, grade, completion and award data (for H4).

### Step 3 — Package identity (for H2)

Compute SHA-256 hashes of the packages deployed in Brightspace (via M-d) and of TCGI's source Rise exports. Record matches and mismatches. **Only a matching (or Brightspace-extracted) build is a candidate for resuming suspend data.**

### Step 4 — Injection test (the core proof, on synthetic learners only)

For L2–L5, seed the D2 harness with the extracted `cmi` values (`suspend_data`, `location`, `lesson_status` or `completion_status`, `success_status`, `score`, `entry = resume`) against the **same package build**. Then launch it.

- **Pass:** Rise resumes at the recorded screen, shows the same completed lessons, and a quiz attempt count matches where the package tracks it.
- **Control:** repeat with a re-published build of the same course to confirm or refute H2.
- Run this for each runtime candidate (ADR-0002).

### Step 5 — Real active learners (structural only, inside TCGI's environment)

Run the chosen extraction method for the **pilot cohort's real active learners**. TCGI's operator produces **only**:
- Counts by course, status and access-end date (this also answers the brief's missing "active B2C count").
- The percentage with `suspend_data` present, a length distribution, and the percentage near the 1.2 limit.
- The percentage whose package build matches.
- The percentage mappable to a miniOrange subject without email (H3).
- A sample of 10 learners, re-run through Step 4 **inside the TCGI environment**, with pass or fail per learner recorded against a pseudonymous ID.

### Step 6 — Report and decision

The report states, per course: **GO** (granular transfer verified), **PARTIAL** (for example completion transfers but position doesn't), or **NO-GO**. It includes the evidence, and the recommended transition path (§6) for approval (DEC-28).

## 5. Spike exit criteria

- Each hypothesis H1–H5 is marked confirmed, refuted or inconclusive, with evidence.
- Injection test results for each runtime candidate.
- Real-cohort structural statistics.
- A per-course recommendation, and the list of learners needing individual handling (by pseudonymous ID).
- Estimates for the migration tooling (M1–M3), updated.

## 6. Fallback if granular transfer is impossible (per course, per learner state)

The brief's options, made operational. **Every choice needs Product/Ops approval (DEC-28) and learner communication before cutover.** The principle is *no unfair loss of study or assessment entitlement* (brief §3).

| Learner state at cutover | Preferred path | Alternative | Never |
|---|---|---|---|
| Enrolled, not started | Migrate the enrolment and access dates | — | — |
| Some lessons complete, none in progress | Transfer **completed units**, marked `source = migrated`, with evidence retained and verified against Brightspace | — | Count migrated units towards new CPD twice |
| Mid-lesson (suspend data not transferable) | **Finish the course on Brightspace** during the parallel run, if the course end is before the bridge ends | Transfer completed units and restart the in-progress lesson in the new LMS, with an access extension per DEC-28 | Silently drop progress |
| Mid-summative assessment, or has used attempts | Finish on Brightspace, **or** migrate with the attempt count carried over (attempts used ≤ attempts allowed per DEC-16) | Individual exception, approved by Aishwarya | Reset or reduce attempts without approval |
| Completed, and credential pending | Stay on Brightspace until issuance, or transfer the completion plus a credential request | — | Issue a duplicate credential |
| Enterprise learner whose agreement renews during Q3 | Migrate at the renewal point (staggered, per brief §7) | — | Hard cutover across all clients |

Every learner who isn't on the preferred path gets an **exceptions register** entry recording:
- Pseudonymous ID, course, and state.
- The path chosen, approver and date.
- The communication sent.
- The access-end date before and after.
- Its resolution.

A course isn't switched until its critical exceptions are closed and rollback has been rehearsed.

## 7. Parallel-run rules (inputs to DEC-29)

- A final **source-of-truth timestamp** per cohort. Before it, Brightspace is authoritative. After it, the LMS is.
- Changes in Brightspace after that timestamp (for example a late quiz attempt) are frozen, or captured by a delta extract and reconciled.
- Brightspace access for a transitioned learner is removed only after verification, never before.

## 8. Risks to the spike itself

| Risk | Mitigation |
|---|---|
| Brightspace data export features aren't in TCGI's licence tier | Ask D2L early (M-c) after approval. Fallback paths don't depend on it |
| No permission to create synthetic learners | Use a Brightspace sandbox or test org, if the contract offers one |
| Real-data handling isn't approved in time | Run Steps 1–4 on synthetic learners. Step 5 slips, and the risk is escalated |
