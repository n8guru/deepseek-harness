// Host half — voice-turn-director step 1 (studio project 1919333).
//
// Registers ONE route so the browser can report TTS playback status
// (clip started/ended/failed, block complete, interrupted mid-clip) as it
// actually happens, and delivers it into the model's context via
// agent.inject() -- "queue model-facing context for the next pre-step
// without waking the driver" (docs/subsystems/core.md). This is a
// notification the model sees on ITS next turn, never a live interrupt: real
// mid-response barge-in is a later voice-turn-director step and needs
// agent.steer(), a different and more invasive mechanism.
//
// Design constraint (operator, this session): stay a plugin, not a DSH core
// change, and fit the existing "same voice stack everywhere" rule (insight
// 64085/72781) -- one canonical browser TTS queue, no parallel path. This
// route only OBSERVES what the browser's existing queue (lib/client.js
// createPipelinedQueue) already does; it adds no new synthesis or playback
// logic.
//
// The bridge (~/scratch/dsh-voice/stt_bridge.py POST/GET /tts-status) is a
// SEPARATE durable ring-buffer log the browser also posts to, for history and
// the dsh_voice_status tool below. This route is the live path; the bridge
// is the queryable-after-the-fact path. Both read the same browser-side
// events; neither depends on the other.
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-voice";
export const inject = ["webServer", "agents", "tools"];

var STATUS_PATH = "/api/dsh-voice/tts-status";
var PLUGIN_SOURCE = { kind: "plugin", plugin: "dsh-voice" };

var EVENT_KINDS = new Set([
  "clip_start", "clip_end", "clip_failed", "interrupted", "block_complete", "block_skipped", "block_failed",
]);

function readJsonBody(req, maxBytes) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var total = 0;
    req.on("data", function (chunk) {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () {
      try {
        var raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

// A block only matters to the model if it was actually meant to be heard
// (wantSpeak on) and if it either finished cleanly or was cut off partway --
// clip_start alone is not worth a turn of context, it is just plumbing.
var REPORTABLE_EVENTS = new Set(["clip_failed", "interrupted", "block_complete", "block_skipped", "block_failed"]);

function describeEvent(body) {
  var event = body.event;
  var text = typeof body.text === "string" ? body.text : "";
  var short = text.length > 160 ? text.slice(0, 157) + "…" : text;
  if (event === "block_skipped" || event === "block_failed") {
    return "[voice] spoken block " + (event === "block_skipped" ? "was skipped" : "encountered a queue failure")
      + " (reason: " + (body.reason || "unknown") + "). Playback is not confirmed.";
  }
  if (event === "block_complete") {
    return "[voice] spoken block finished playing: \"" + short + "\"";
  }
  if (event === "interrupted") {
    var spokenSoFar = typeof body.spokenSoFar === "string" ? body.spokenSoFar : "";
    var spokenShort = spokenSoFar.length > 160 ? spokenSoFar.slice(0, 157) + "…" : spokenSoFar;
    return "[voice] spoken clip was interrupted (reason: " + (body.reason || "unknown")
      + "). Nate heard approximately: \"" + spokenShort + "\" of the clip \"" + short + "\".";
  }
  if (event === "clip_failed") {
    return "[voice] a spoken clip failed to play (reason: " + (body.reason || "unknown")
      + "): \"" + short + "\". Nate did not hear this text.";
  }
  return null;
}

export function apply(ctx) {
  ctx.effect(function () {
    var disposeRoute = ctx.webServer.register({
      kind: "exact",
      path: STATUS_PATH,
      handler: function (req, res) {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        readJsonBody(req, 64 * 1024)
          .then(function (body) {
            var event = String((body && body.event) || "");
            if (!EVENT_KINDS.has(event)) {
              sendJson(res, 400, { ok: false, error: "unknown event: " + event });
              return;
            }
            var key = String((body && body.key) || "");
            if (!key) {
              sendJson(res, 400, { ok: false, error: "key required" });
              return;
            }
            sendJson(res, 200, { ok: true });
            if (!REPORTABLE_EVENTS.has(event)) return; // clip_start is plumbing only
            var sessionIdRaw = String((body && body.sessionId) || "");
            if (!sessionIdRaw) return; // no session to attribute this to
            var text = describeEvent(body);
            if (!text) return;
            try {
              var agent = ctx.agents.get(SessionId(sessionIdRaw));
              if (!agent) return; // session not live (closed tab, reload) -- drop, do not queue blind
              agent.inject(createUserMessage({
                content: [{ type: "text", text: text }],
                source: PLUGIN_SOURCE,
              }));
            } catch (_error) {
              // Never let a malformed sessionId or a disposed agent break the
              // browser's report -- the response already succeeded above.
            }
          })
          .catch(function (error) {
            sendJson(res, 400, { ok: false, error: String((error && error.message) || error) });
          });
      },
    });
    return disposeRoute;
  }, "dsh-voice: /api/dsh-voice/tts-status route");

  // Explicit on-demand check, for when the model wants to confirm status
  // without waiting for the next natural turn boundary (e.g. right after
  // emitting a <spoken> block, before doing other work). The bridge's own
  // ring buffer is the source of truth here since it has real history;
  // this tool is a thin proxy so the model does not need a raw HTTP call.
  // Registration is effect-based (disposing this plugin fiber unregisters
  // it); no explicit ctx.effect() wrap needed, matching every other
  // first-party tool (dsh-tool-todo, dsh-tool-web, ...).
  ctx.tools.register(defineTool({
    name: "dsh_voice_status",
    description: "Check whether recent <spoken> blocks actually played, failed, or were interrupted. Use this to confirm a spoken reply was heard, or right after a barge-in to see how much of the prior clip Nate actually heard.",
    parameters: {
      limit: { type: "number", description: "Max recent events to return (default 10)." },
    },
    output: {
      schema: { type: "array", items: { type: "json" } },
      render: function (_args, value) {
        return [{ type: "text", text: JSON.stringify(value, null, 2) }];
      },
    },
    async execute(args) {
      var limit = (args && typeof args.limit === "number") ? args.limit : 10;
      var url = "http://127.0.0.1:7861/tts-status?limit=" + encodeURIComponent(String(limit));
      var response = await fetch(url);
      var body = await response.json();
      return (body && body.events) || [];
    },
  }));
}
