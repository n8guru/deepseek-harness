#!/usr/bin/env python3
"""Drive the REAL forge-agent-os native maintenance adapter against a built Host.

argv: phase base_url state_json_path
state JSON: {"bearer", "faoLib", "runDir"}

The external Forage claim admission transport is an in-process FIXTURE here
(the Forage route + PostgreSQL proof is a separate assembled step); every
native call goes over loopback HTTP to /api/maintenance.receive.
Prints one line prefixed MAINT_ADAPTER_PHASE; exits non-zero on surprise.
"""
import copy
import json
import os
import sys

phase, base, state_path = sys.argv[1:4]
state = json.load(open(state_path))
sys.path.insert(0, state["faoLib"])
from dsh_upgrade_run import prepare  # noqa: E402
from dsh_host_external_admission import HostExternalAdmission, SCOPE  # noqa: E402
from dsh_native_maintenance import (HostNativeMaintenance, NativeMaintenanceRefused,  # noqa: E402
                                    http_transport, baton_digest)

RUN = os.path.join(state["runDir"], "run.json")
EXT = os.path.join(state["runDir"], "external-fixture.json")


def external_fixture(request):
    """Fixture Forage port persisted across processes (crash/retry realism)."""
    intent = json.load(open(EXT)) if os.path.exists(EXT) else None
    if request["action"] == "close" and intent is None:
        intent = {"scope": SCOPE, "host": request["host"], "owner": request["owner"],
                  "run_id": request["run_id"], "intent_id": "fixture-intent",
                  "prior_pause_state": request["prior_pause_state"], "state": "draining"}
    if request["action"] == "release":
        intent.update(state="completed", released=True)
    json.dump(intent, open(EXT, "w"))
    return {"status": 200, "body": {"scope": SCOPE, "action": request["action"],
            "host_admission": copy.deepcopy(intent), "host_native_closed": False,
            "all_external_producers_closed": False, "activation_supported": False}}


def out(**fields):
    print("MAINT_ADAPTER_PHASE " + json.dumps({"phase": phase, **fields}, sort_keys=True))


native = HostNativeMaintenance(RUN, owner="fao:owner", transport=http_transport(base, state["bearer"]))
external = HostExternalAdmission(RUN, host="forge", owner="fao-owner", transport=external_fixture)
record_phase = lambda: json.load(open(RUN))["phase"]  # noqa: E731

if phase == "close":
    os.makedirs(state["runDir"], mode=0o700, exist_ok=True)
    pin = {"commit": "a" * 40, "checkout": "/candidate", "home": "/home", "entrypoint": "/bin.js"}
    manifest = {"run_id": "step70-assembled", "candidate": pin, "prior": {**pin, "commit": "b" * 40},
                "prior_pauses": {"registry": True, "notifier": False, "mesh-pump": True},
                "baton": {"project": "mesh-dsh-merge", "project_id": 1385124, "step": "70", "cursor": "71",
                          "release": {"target": "0.2.0-rc.2", "candidate_commit": "a" * 40},
                          "evidence_refs": ["docs/evidence/mesh-dsh-step70-142247.md"],
                          "obligations": ["verify step 100 cross-provider", "release recovery hold only after review"],
                          "lineage": {"run_id": "step70-assembled", "predecessor_session": "caller-agent",
                                      "handoff": "native-maintenance-successor"}}}
    prepare(RUN, manifest, 20)
    try:
        native.close()
        raise SystemExit("native close before external hold must refuse")
    except NativeMaintenanceRefused:
        pass
    external.bind_source()
    external.close()
    first = native.close()
    again = native.close()  # lost-reply retry of the same owner/run
    out(drain=first["drain"], retry_drain=again["drain"]["verdict"], record=record_phase())
elif phase == "probe":
    out(drain=native.status()["drain"], record=record_phase())
elif phase == "drain":
    seen = []
    try:
        native.wait_drained(poll=0.2, report=lambda o: seen.append(o["drain"]["verdict"]))
        out(result="drained", observed=sorted(set(seen)), record=record_phase())
    except NativeMaintenanceRefused as exc:
        out(result="refused", reason=str(exc), observed=sorted(set(seen)), last=native.status()["drain"],
            record=record_phase())
elif phase == "claim":
    first = native.claim_successor()["native"]["successor_session_id"]
    # Fresh adapter object == controller crash/restart; same claim, same identity.
    again = HostNativeMaintenance(RUN, owner="fao:owner",
                                  transport=http_transport(base, state["bearer"])).claim_successor()
    out(session=first, same=again["native"]["successor_session_id"] == first,
        digest=baton_digest(json.load(open(RUN))["manifest"]), record=record_phase())
elif phase == "early-external-release":
    try:
        external.release()
        raise SystemExit("external release while native held must refuse")
    except Exception as exc:  # ExternalAdmissionRefused
        out(refused=type(exc).__name__, record=record_phase())
elif phase == "start":
    try:
        record = native.start_successor()
        out(result="started", session=record["native"]["successor_session_id"],
            successor=native.status()["successor"], record=record_phase())
    except NativeMaintenanceRefused as exc:
        out(result="refused", reason=str(exc), successor=native.status()["successor"], record=record_phase())
elif phase == "start-retry":
    # Fresh adapter object == controller crash/restart after (or during) start.
    again = HostNativeMaintenance(RUN, owner="fao:owner", transport=http_transport(base, state["bearer"]))
    record = again.start_successor()
    out(result="started", session=record["native"]["successor_session_id"],
        successor=again.status()["successor"], record=record_phase())
elif phase == "release":
    native.release()
    native.release()  # idempotent retry
    ext = external.release()
    out(record=ext["phase"], released_for=json.load(open(RUN))["native"]["released_for"],
        prior_pauses=ext["manifest"]["prior_pauses"])
elif phase == "rollback-release":
    native.release(rollback=True)
    native.release(rollback=True)  # idempotent retry
    ext = external.release()
    out(record=ext["phase"], released_for=json.load(open(RUN))["native"]["released_for"],
        prior_pauses=ext["manifest"]["prior_pauses"])
else:
    raise SystemExit("unknown phase " + phase)
