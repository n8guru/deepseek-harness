#!/usr/bin/env python3
"""Stdlib-only Python caller for the native Focus / notification / maintenance HTTP seams.

Stands in for the Forage-side Python producers (notifier, mesh supervisor) that
talk to a DSH Host over loopback HTTP. It runs one named phase per invocation
against a Host assembled from built packages, prints exactly one JSON line
prefixed ``PY_CALLER_PHASE``, and exits non-zero on any unexpected response.

argv: phase base_url state_json_path
state JSON: {"authUrl", "bearer", "sessionId", "cookie"?}
"""
import http.client
import json
import sys
import threading
import urllib.parse


def fail(message):
    print("PY_CALLER_ERROR " + message, file=sys.stderr)
    sys.exit(1)


def request(base, method, path, body=None, headers=None):
    parsed = urllib.parse.urlsplit(base)
    conn = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=30)
    data = None if body is None else json.dumps(body).encode()
    all_headers = {"content-type": "application/json"} if data is not None else {}
    all_headers.update(headers or {})
    conn.request(method, path, body=data, headers=all_headers)
    response = conn.getresponse()
    raw = response.read().decode("utf-8", "replace")
    result = (response.status, raw, response.getheader("set-cookie"))
    conn.close()
    return result


def expect(label, actual, wanted):
    if actual != wanted:
        fail("%s: expected %r, got %r" % (label, wanted, actual))


def main():
    phase, base, state_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(state_path) as handle:
        state = json.load(handle)
    sid = state["sessionId"]
    bearer = {"authorization": "Bearer " + state["bearer"]}
    out = {"phase": phase}

    if phase == "admit":
        auth = urllib.parse.urlsplit(state["authUrl"])
        status, _, set_cookie = request(base, "GET", auth.path + "?" + auth.query)
        if not set_cookie:
            fail("browser exchange returned no cookie (status %d)" % status)
        state["cookie"] = set_cookie.split(";", 1)[0]
        with open(state_path, "w") as handle:
            json.dump(state, handle)
    cookie = {"cookie": state.get("cookie", "")}

    def focus(body, headers):
        payload = dict(body)
        payload["sessionId"] = sid
        return request(base, "POST", "/api/session.focus", payload, headers)

    note = {"sessionId": sid, "items": [{
        "sequence": "py-changed-receipt-1", "text": "python worker report",
        "evidenceRefs": ["py://artifact"],
        "urgency": {"kind": "safety", "reason": "authorized but Focus still holds"},
    }]}

    if phase == "admit":
        status, raw, _ = focus({"action": "set", "enabled": True}, cookie)
        expect("focus set", (status, json.loads(raw)), (200, {"enabled": True, "queued": 0}))
        expect("cookie cannot admit", request(base, "POST", "/api/notifications.admit", note, cookie)[0], 403)
        expect("bearer cannot drive operator focus", focus({"action": "inspect"}, bearer)[0], 401)
        results = [None, None]

        def admit(index):
            results[index] = request(base, "POST", "/api/notifications.admit", note, bearer)

        threads = [threading.Thread(target=admit, args=(i,)) for i in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        expect("concurrent admit statuses", [r[0] for r in results], [200, 200])
        receipts = [json.loads(r[1]) for r in results]
        expect("same message id", receipts[0]["receipts"][0]["messageId"], receipts[1]["receipts"][0]["messageId"])
        expect("exactly one duplicate", sorted(r["receipts"][0]["duplicate"] for r in receipts), [False, True])
        forged = dict(note, origin="foreground")
        expect("forged foreground origin", request(base, "POST", "/api/notifications.admit", forged, bearer)[0], 400)
        out.update(origin=receipts[0]["origin"], focus=receipts[0]["focus"], duplicates=1)
    elif phase == "check":
        status, raw, _ = focus({"action": "check", "checkId": "py-check-1"}, cookie)
        expect("check", status, 200)
        out.update(check=json.loads(raw) if raw else None)
    elif phase == "recheck":
        expect("same check id is idempotent", focus({"action": "check", "checkId": "py-check-1"}, cookie)[0], 200)
        late = dict(note, items=[{"sequence": "py-late-receipt", "text": "late python worker evidence"}])
        expect("late admit", request(base, "POST", "/api/notifications.admit", late, bearer)[0], 200)
        status, raw, _ = focus({"action": "inspect"}, cookie)
        expect("inspect", status, 200)
        out.update(focus=json.loads(raw))
    elif phase == "maintenance":
        def maintenance(body, headers):
            return request(base, "POST", "/api/maintenance.receive", body, headers)

        expect("cookie cannot close", maintenance({"action": "close", "runId": "py-run"}, cookie)[0], 403)
        status, raw, _ = maintenance({"action": "close", "runId": "py-run"}, bearer)
        expect("close", status, 200)
        closed = json.loads(raw)
        expect("closed phase", (closed.get("owner"), closed.get("runId"), closed.get("phase")), ("py:caller", "py-run", "closed"))
        delivery = {"action": "deliver-receipts", "runId": "py-run", "items": [{
            "sequence": "py-supervisor", "kind": "supervisor", "payload": "python supervisor checkpoint",
            "target": {"kind": "agent", "sessionId": sid},
        }]}
        results = [None, None]

        def deliver(index):
            results[index] = maintenance(delivery, bearer)

        threads = [threading.Thread(target=deliver, args=(i,)) for i in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        expect("concurrent deliveries", [r[0] for r in results], [200, 200])
        acks = [json.loads(r[1]) for r in results]
        expect("identical deliveries", acks[0]["deliveries"], acks[1]["deliveries"])
        expect("delivered", acks[0]["deliveries"][0]["status"], "delivered")
        changed = dict(delivery, items=[dict(delivery["items"][0], payload="different")])
        expect("conflicting payload", maintenance(changed, bearer)[0], 409)
        expect("foreign run release", maintenance({"action": "release", "runId": "other-run"}, bearer)[0], 409)
        expect("forged owner release", maintenance({"action": "release", "runId": "py-run", "owner": "forged"}, bearer)[0], 409)
        expect("release", maintenance({"action": "release", "runId": "py-run"}, bearer)[0], 200)
        out.update(messageId=acks[0]["deliveries"][0]["messageId"], closed=True, released=True)
    else:
        fail("unknown phase " + phase)
    print("PY_CALLER_PHASE " + json.dumps(out, sort_keys=True))


if __name__ == "__main__":
    main()
