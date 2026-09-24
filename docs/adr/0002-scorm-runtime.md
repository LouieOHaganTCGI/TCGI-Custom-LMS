# ADR-0002 — SCORM runtime and launch architecture

- Status: **Method accepted** (Boris, 24 Sep 2026). The runtime *selection* stays open until real-package evidence exists (DEC-13). Phase B builds the `ScormRuntimeProvider` port with Option 3 (`scorm-again`) as the first evaluated adapter. That is not a final selection
- Date: 2026-09-24

## Context

CAT-01 requires importing, validating, launching and tracking real Rise SCORM 1.2 and 2004 packages, including completion, success, score, attempts, suspend and resume, and relaunch. The brief forbids a hand-rolled runtime without a reviewed specialist decision. The operating rules forbid a "toy" player being called compliant. About 400 microlessons exist. Their package granularity is unknown (A-03, A-04, DEC-04). Migrated progress may need suspend data restored (06).

A SCORM "runtime" is several parts, and the options differ in which parts they supply:

1. **Package processing:** unzip, parse `imsmanifest.xml`, validate, identify SCOs and launch URLs, store.
2. **Run-time API:** the JavaScript `API` (1.2) or `API_1484_11` (2004) object the content finds by walking `window.parent`/`opener`, and the CMI data model with its validation rules and error codes.
3. **Persistence:** saving CMI state server-side per attempt, and restoring it on relaunch.
4. **Sequencing and navigation (2004 only):** activity trees, rollup and navigation requests across multiple SCOs.
5. **Conformance evidence:** ADL test suite results and a record of real-package testing.

## Options

### Option 1 — Rustici Engine (commercial, self-hosted)

- Provides 1–5, plus AICC, xAPI and cmi5. Runs as a separate service inside our EU infrastructure, integrated via its REST API, with launch links generated per registration.
- **Licence:** commercial, quote-based. We have no quote. Finance must obtain one (DEC-13). The recurring cost profile (annual, or per learner or registration) must be confirmed.
- **EU hosting:** self-hosted, so data stays in our region. Confirm current platform requirements (runtime and supported databases) with the vendor.
- **Integration:** our LMS keeps enrolment, entitlement and academic records. The engine keeps runtime state. We mirror completion, success and score into our DB via engine callbacks or polling, which is still a mapping we own.
- **Export and exit:** runtime data sits in a database we host. Confirm the licence allows our own access and export after termination.
- **Testing:** vendor conformance plus our real-package matrix.
- **Risks:** a second technology to operate (patching, monitoring); vendor dependency; cost.

### Option 2 — Rustici SCORM Cloud (commercial SaaS)

- Provides 1–5 as a hosted service with a REST API. Least engineering and ops effort.
- **EU hosting: unverified.** We must confirm whether an EU data region is offered and contractually committed. If processing is outside the EU, it likely fails the brief's EU-hosting mandate (§6) and needs DPIA and transfer review. **This is the first question to ask the vendor.**
- **Licence:** subscription, typically usage-based. The profile needs a quote.
- **Export and exit:** depends on API export of registrations and runtime data. Test it in the trial.
- **Risks:** learner data held by a sub-processor; recurring cost that scales with usage; lock-in of runtime state; latency to the service.

### Option 3 — Open-source run-time API (`scorm-again`, MIT) plus our own package processing and persistence

- `scorm-again` supplies part 2 (the 1.2 and 2004 API objects and CMI data model validation) in TypeScript and is actively maintained. We supply parts 1 and 3 (manifest parsing, storage, commit endpoint), which are well-bounded.
- **Part 4 (2004 sequencing):** the level of support in the current release **must be verified**. If TCGI's Rise packages are single-SCO (A-03), the sequencing needed is trivial, but that has to be proven by scanning every manifest, not assumed.
- **Licence:** MIT, no recurring fee. Our costs are our own engineering and our own conformance testing.
- **EU hosting:** fully in our stack.
- **Export and exit:** everything is in our Postgres.
- **Risks:** we own conformance. There is maintainer bus-factor on a community project, mitigated by pinning versions, vendoring and keeping a fork plan. This counts as "hand-rolled" for anything the library doesn't cover, so it needs the specialist review the brief requires (an external SCORM specialist review of our integration: DEC-13 includes whether to buy that review).

### Option 4 — Moodle's SCORM player (if ADR-0001 Option C is chosen)

This isn't separable from Moodle. It's listed for completeness. Moodle documents SCORM 2004 support as incomplete, so check the current state.

### Not viable

- **A bespoke runtime API written from scratch.** Excluded by the brief.
- **Content-side wrappers** such as pipwerks. These are libraries *inside* content that call an LMS API. They are not LMS runtimes.
- **Re-publishing all content as cmi5 or xAPI now.** A possible later path (Rise can export other formats), but it means re-exporting about 400 lessons and would break continuity of existing SCORM suspend data. Not an MVP option.

## Evaluation — the D2 PoC

The decision gets made on evidence, not on marketing claims. The D2 PoC (a throwaway evaluation harness, **not** product code, labelled as such) runs **the same ≥ 2 sanitised Rise packages** (at least one SCORM 1.2 and one 2004, at least one with a quiz) through Option 3 and, subject to trial terms, Option 1 or 2.

| # | Test case | Pass criterion |
|---|---|---|
| R1 | Import and validate the manifest | Correct SCO or launch detection. Invalid zip or manifest rejected with a clear error |
| R2 | First launch on desktop Chromium, Firefox and Safari | Content renders. `Initialize` succeeds. No console API errors |
| R3 | Partial progress then exit (close tab) | `suspend_data`, `location` and status are persisted server-side within the commit window |
| R4 | Resume on a different browser or device | Rise resumes at the same position (visually confirmed and in CMI) |
| R5 | Complete the lesson | 1.2: `lesson_status` completed or passed. 2004: `completion_status` completed, and `success_status` if a quiz |
| R6 | Quiz pass, fail and score | The score (raw and scaled) matches what the content reports. Pass or fail follows the package's mastery settings |
| R7 | Relaunch after completion | The behaviour matches an agreed attempt policy (review mode vs new attempt). The policy comes from DEC-16 |
| R8 | Mobile: iOS Safari and Android Chrome, real devices | R2–R5 pass. Commit on `pagehide`/`visibilitychange` doesn't lose data |
| R9 | Network interruption mid-session | Commits retry. No silent data loss. The learner is warned |
| R10 | 1.2 `suspend_data` near the 4,096-char limit | Handled without truncation errors. Real Rise payload sizes recorded |
| R11 | **Suspend-data injection** | Inject a `suspend_data` string captured from another run (and from Brightspace in the migration spike) and confirm Rise resumes at that point |
| R12 | Accessibility of the player shell | Keyboard operable, focus managed, exit control reachable |
| R13 | Export | All runtime state for a registration can be exported as JSON |

Weighted criteria for the decision: conformance on TCGI packages (R1–R11) is a **gate**. Among the options that pass, compare EU residency (gate), total recurring cost (Finance), exit and export, operational burden, and integration effort.

## Launch architecture (applies to every option)

- **Separate content origin.** Package files are served from a dedicated origin (for example `content.<lms-domain>`), never from the app origin. Untrusted package JavaScript then can't read app cookies or call app APIs with the learner's session.
- The SCORM API **must be same-origin with the content frame** (API discovery walks `window.parent`). So the *player shell* that hosts the API object is also served from the content origin. It talks to the app API with a **short-lived, single-registration launch token** (scoped to one attempt; it can only read and write that attempt's CMI state). It never uses the session cookie.
- Package files are stored immutably, keyed by ContentVersion hash, and served with signed short-lived URLs or cookie-less token checks at the CDN. Cross-tenant package access is tested in TS-SEC.
- Headers: `Content-Security-Policy` on the app origin (strict). A controlled `frame-ancestors` on the content origin, so it can only be framed by the app. `X-Content-Type-Options: nosniff`.
- **Score trust:** CMI values are learner-controlled, because anyone can call `SetValue` from devtools. They are stored as reported, labelled as `client_reported`, and **not used as the sole evidence for summative diploma results** unless Product explicitly accepts that (DEC-15, threat T-11).

## Proposed decision

1. Build a **`ScormRuntimeProvider` port** in our code (launch, commit, read state, export) so the LMS domain doesn't depend on any one runtime.
2. Run the D2 PoC with **Option 3 and Option 1** (and Option 2 only if the vendor confirms EU residency).
3. **Provisional preference, which the evidence can override:**
   - If every TCGI package in the inventory is single-SCO and Option 3 passes R1–R13, prefer **Option 3** plus a paid **external SCORM specialist review**. That gives the lowest recurring cost and full data ownership.
   - If any launch package needs multi-SCO 2004 sequencing, or Option 3 fails the gate, prefer **Option 1** (self-hosted, EU), subject to the Finance quote.
4. Record the result as ADR-0002a with the full compatibility matrix attached.

## Consequences

- There is a small abstraction cost now, but either runtime can be swapped in later without migrating enrolment or academic data.
- Option 3 commits us to maintaining a conformance test suite. That's desirable anyway: it becomes TS-SCORM.
