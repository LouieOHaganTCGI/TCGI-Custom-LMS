# SCORM test fixtures

**These are synthetic packages written for this repository. They are NOT TCGI Rise exports.**

They exist to test the LMS plumbing end to end: API discovery, initialise, suspend_data and location
persistence, resume, completion, score and finish. They use the standard SCORM run-time API exactly as
content does, but they are tiny and deterministic.

Passing tests with these fixtures says **nothing** about Articulate Rise compatibility. That evidence
needs real, sanitised Rise 1.2 and 2004 exports (DEC-03) run through the R1–R13 matrix in
`docs/adr/0002-scorm-runtime.md`. Put those packages in `fixtures/scorm/rise/` (git-ignored unless
approved for commit) and run `npm run test:e2e -- --grep @rise`.
