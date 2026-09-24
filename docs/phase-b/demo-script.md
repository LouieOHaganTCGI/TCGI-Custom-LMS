# Phase B demo script (about 15 minutes)

**Audience:** Boris (acceptance), Aishwarya (LMS rules), Aayushi and Andre (observers).
**Environment:** local stack on the presenter's machine. **Not staging** (see the report, §3). All people and packages are synthetic.

## 0. Setup (before the meeting, about 3 minutes)

```bash
npm ci
npm run db:local          # local PostgreSQL 16 with lms_owner / lms_app roles
npm run dev               # migrate + seed + app :3000, content :3001, test IdP :4400, HubSpot stub :4500
```

Open http://localhost:3000 in a private window. The console banner confirms the **LOCAL TEST IdP (not miniOrange)** and the **LOCAL STUB (not HubSpot)**.

## 1. Sign-in, and a scoped identity (ID-01, ID-02): 2 min

1. Click **Sign in**. The sign-in page names the identity provider as *"Local test IdP (not miniOrange)"*.
2. On the IdP page (clearly labelled as a test IdP), choose **Brian Synthetic (learner-ent-a-1)**.
3. Open **My account**. Point out:
   - The identity key is **issuer + subject** (`learner-ent-a-1`). Email is only an attribute.
   - Organisation: **Synthetic Enterprise A**. Role: learner only.

*Talking point:* switching to the miniOrange sandbox means changing `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` (DEC-06), plus provisioning sandbox users with `cli person:provision`.

## 2. Entitlement fixture, then enrolment: 2 min

1. On **My learning**, "Available to you" lists *Synthetic course: SCORM 1.2 lesson*. That comes from an **entitlement fixture** created through the same command the S4 signed-purchase handler will call (`source = phase-b-fixture`).
2. Click **Enrol**. The enrolment is pinned to course revision 1, and its access end is copied from the entitlement.

## 3. Launch, save, restore (CAT-01, LRN-01): 4 min

1. Click **Start lesson**. The browser moves to **http://localhost:3001**, the separate content origin (ADR-0002).
2. In the lesson (a synthetic package, *not* a Rise export): click **Next screen**. It shows "Screen 2 of 3".
3. Click **Save and exit lesson**, then **Save and return to course**. The lesson shows **In progress**.
4. Click **Resume lesson**. The lesson opens at **Screen 2 of 3** with *"Resumed from your saved progress."*
5. Click **Complete lesson (score 80)**, then **Save and return to course**.

## 4. Completion display (LRN-02 minimal): 1 min

- The course page shows **Course completed on …**, *Passed*, *"Score reported by the lesson: 80"*, and the first-completed timestamp.
- *Talking point:* the score is labelled as **reported by the lesson**. SCORM scores come from the browser and can be forged (T-11), so diploma assessments need DEC-15.

## 5. Event queued and delivered (INT-03 first event): 2 min

1. Sign out and sign in as **Dana Admin (synthetic)**. *If the IdP remembers Brian, use a fresh private window. LMS sign-out doesn't end the IdP session (single logout is DEC-06).*
2. Open **Admin → Integration events**. It shows `enrolment.created` and `course.completed` as **Delivered**, with their delivery attempts.
3. Optional: `curl http://127.0.0.1:4500/events` shows the signed envelopes the stub received and verified.
4. Optional fault demo: `curl -X POST "http://127.0.0.1:4500/_control/fail?count=10&status=400"`, then complete another course. The event is **Dead-lettered**. Click **Replay** after `...fail?count=0`, and it's delivered and the replay is audited.

## 6. Admin audit record (OPS-03 foundation): 2 min

1. Open **Admin → Audit trail**. Filter by entity type `enrolment`, or click an entity link.
2. Show `enrolment.created`, `attempt.launched`, `progress.placement_completed` and `enrolment.completed` with the actor, organisation, and before and after values.
3. *Talking point:* entries are append-only (the DB rejects UPDATE and DELETE even for the owner) and hash-chained.

## 7. Isolation (TS-SEC): 2 min

1. As Brian, copy the URL of the enrolment page. Sign in as **Ciara Synthetic (Enterprise B)** in another private window and paste the URL: **Page not found**.
2. As Ciara, go to `/admin`: **Page not found**.
3. Mention the automated evidence: 106 integration tests, including a direct-SQL RLS suite and a hostile-package browser test (see the report).

## Automated run of the same journey

```bash
npm run test:e2e          # includes the full journey above for SCORM 1.2 and 2004
```

---

# Part 2 demo: enterprise manager, purchase and refund, CPD (about 15 minutes)

Synthetic people added for this part:
- **Eoin Manager (synthetic)**: manager of Synthetic Enterprise A.
- **Grace Newstarter** and **Hugh Newstarter**: IdP-only users with *no* LMS account, for the invitation demo.

## 8. Manager portal (ENT-01 to ENT-03): 5 min
1. Sign in as **Eoin**. Open **Manage team**. Show seats in use against the limit, team progress, the agreement card, and **Export team progress (CSV)**.
2. **Invite a learner**: "Grace Newstarter". Copy the one-time link. *Email delivery is pending DEC-25.*
3. In a new private window, open the link. **Accept and sign in** as *Grace Newstarter*. The welcome message confirms her account is linked.
4. Back as Eoin, **Assign a course** to Grace. Her seat shows "Seat active", and seats in use goes up by one.
5. As Grace, enrol and complete the lesson. Then open **CPD**, which shows the award. As Eoin, the team table shows *Completed* and her CPD.
6. *Isolation talking point:* Eoin can't open Enterprise B's team, even by editing the URL, and never sees an employee's personal B2C courses.

## 9. Purchase and refund (INT-01, INT-02): 4 min
```bash
npx tsx dev/commerce-sim.ts purchase --learner learner-ent-b-1 --product SYN-PROD-PATHWAY-01 --order SIM-1
```
1. As **Ciara**, the pathway appears under "Available to you". Enrol.
2. `npx tsx dev/commerce-sim.ts refund --learner learner-ent-b-1 --product SYN-PROD-PATHWAY-01 --order SIM-1`, then reload the course page. It shows **Withdrawn**, and launching is disabled. Progress is kept.
3. As **Dana (admin)**: open **Purchase and refund events**. Both events are *Processed*, and the resulting access shows *Revoked*.
4. `... partial-refund ...` is **held** with the reason `partial_refund_rule_pending_DEC-11`, and access is unchanged. That's the point: rules nobody has decided aren't guessed.

## 10. CPD and transcript (LRN-05): 2 min
- **CPD** shows totals by calendar year and in total, with a year filter. **View transcript** gives a print-ready page ("Print or save as PDF"). **Download CSV**.
- Admin → **Content and courses**: set a course's CPD value. Existing awards are unchanged (a snapshot).

## 11. Operations overview (OPS-01): 1 min
- Admin → **Overview** shows live counts, plus held events and dead letters flagged "Needs attention".
