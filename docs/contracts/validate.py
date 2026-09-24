#!/usr/bin/env python3
"""Validate example payloads against the event-contract schemas.

examples/valid/*.json must validate; examples/invalid/*.json must be rejected.
Usage: pip install 'jsonschema[format]>=4.18' && python3 docs/contracts/validate.py
"""
import json
import pathlib
import sys

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

HERE = pathlib.Path(__file__).parent
schemas = {p.name: json.loads(p.read_text()) for p in HERE.glob("*.schema.json")}
registry = Registry().with_resources(
    (s["$id"], Resource.from_contents(s)) for s in schemas.values()
)
# Relative $refs ("envelope.v1.schema.json") resolve against each schema's $id.


def validator_for(doc):
    t = doc.get("type", "")
    name = "entitlement.v1.schema.json" if t.startswith("entitlement.") else "learning-events.v1.schema.json"
    return name, Draft202012Validator(
        schemas[name], registry=registry, format_checker=Draft202012Validator.FORMAT_CHECKER
    )


failures = 0
for expect_valid, folder in ((True, "valid"), (False, "invalid")):
    for path in sorted((HERE / "examples" / folder).glob("*.json")):
        doc = json.loads(path.read_text())
        name, v = validator_for(doc)
        errors = list(v.iter_errors(doc))
        ok = (not errors) if expect_valid else bool(errors)
        failures += not ok
        status = "PASS" if ok else "FAIL"
        detail = "" if expect_valid or not errors else f" (rejected: {errors[0].message[:80]})"
        print(f"{status} {folder}/{path.name} vs {name}{detail}")
        if expect_valid and errors:
            for e in errors:
                print("   ", list(e.absolute_path), e.message)

print(f"\n{failures} failure(s)")
sys.exit(1 if failures else 0)
