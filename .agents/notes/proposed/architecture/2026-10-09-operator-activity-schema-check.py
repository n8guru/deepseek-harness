"""Shape-only executable examples; NOT native activity/admission implementation tests.

Run with Python + jsonschema installed. No network, credentials, sessions or writes.
"""
import copy
import json
from pathlib import Path

from jsonschema import Draft202012Validator

SCHEMA = json.loads(Path(__file__).with_name(
    "2026-10-09-operator-activity-v1.schema.json").read_text())
Draft202012Validator.check_schema(SCHEMA)
count = 0


def check(kind, value, valid=True):
    global count
    validator = Draft202012Validator({
        "$schema": SCHEMA["$schema"], "$defs": SCHEMA["$defs"],
        "$ref": "#/$defs/" + kind,
    })
    errors = list(validator.iter_errors(value))
    assert bool(errors) != valid, (kind, value, [e.message for e in errors])
    count += 1


snapshot = {
    "schema": "operator-activity/v1", "sessionId": "conductor-session",
    "hostEpoch": "host-test-epoch", "activityRevision": 1, "controlRevision": 2,
    "observedAt": 10000, "lastActivityAt": 9000, "activityAgeMs": 1000,
    "idleThresholdMs": 300000, "snapshotTtlMs": 5000, "state": "active",
    "binding": {"bindingEpoch": "binding-test-epoch",
                "principalClass": "authenticated-operator-gui"},
    "focus": "disabled", "stop": "clear", "goal": {"state": "none"},
    "hostAdmission": "open", "foregroundBusy": False,
    "eligible": True, "holdReasons": [],
}
check("snapshot", snapshot)
for state in ("idle", "stale", "unknown"):
    held = {**snapshot, "state": state, "eligible": False,
            "holdReasons": ["activity-" + state]}
    check("snapshot", held)
    check("snapshot", {**held, "eligible": True}, False)
for field, value in (("focus", "enabled"), ("stop", "stopped"),
                     ("hostAdmission", "closed"), ("foregroundBusy", True),
                     ("binding", None), ("activityAgeMs", None)):
    check("snapshot", {**snapshot, field: value}, False)
for phase, activation in (("paused", "disarmed"), ("blocked", "disarmed"),
                          ("active", "disarmed")):
    check("snapshot", {**snapshot, "goal": {
        "state": "present", "id": "g", "revision": 1,
        "phase": phase, "activation": activation}}, False)
for value in (0, 999, 3600001, "300000"):
    check("snapshot", {**snapshot, "idleThresholdMs": value}, False)
for field in snapshot:
    absent = dict(snapshot)
    del absent[field]
    check("snapshot", absent, False)
read = {"version": 1, "action": "activity", "sessionId": "conductor-session"}
check("activityRead", read)
for field in ("origin", "lastActivityAt", "clientTime", "isHuman"):
    check("activityRead", {**read, field: "forged"}, False)
check("activityRead", {**read, "version": 2}, False)
check("activityOpen", {"version": 1, "sessionId": "conductor-session"})
check("activityOpened", {"version": 1, "bindingEpoch": "binding-test-epoch"})
frame = {"version": 1, "bindingEpoch": "binding-test-epoch",
         "sequence": 1, "interaction": "input"}
check("activityFrame", frame)
check("activityFrame", {**frame, "sequence": 0}, False)
check("activityFrame", {**frame, "interaction": "heartbeat"}, False)
check("activityFrame", {**frame, "trusted": True}, False)
guard = {"version": 1, "hostEpoch": "host-test-epoch",
         "bindingEpoch": "binding-test-epoch",
         "activityRevision": 1, "controlRevision": 2}
admission = {"sessionId": "conductor-session",
             "items": [{"sequence": "report-1", "text": "report"}],
             "activityGuard": guard}
check("guardedAdmission", admission)
check("guardedAdmission", {**admission, "items": []}, False)
check("guardedAdmission", {**admission, "items": admission["items"] * 11}, False)
check("guardedAdmission", {**admission, "activityGated": False}, False)
check("guardedAdmission", {k: v for k, v in admission.items()
                          if k != "activityGuard"}, False)
ack = {"accepted": True, "origin": "notifier",
       "receipts": [{"sequence": "report-1", "messageId": "m1", "duplicate": False}],
       "focus": {"enabled": False, "queued": 0}, "delivery": "eligible",
       "activity": snapshot}
check("admissionAck", ack)
check("admissionAck", {**ack, "delivery": "delivered"}, False)
held = copy.deepcopy(ack)
held["delivery"] = "held"
held["activity"].update(eligible=False, stop="stopped", holdReasons=["stop-stopped"])
check("admissionAck", held)
print(f"{count} schema shape examples passed; A01-A22 native behavior tests remain specification only")
