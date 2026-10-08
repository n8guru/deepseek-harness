window.__ModuleLoader__.load({
  id: "dsh-voice",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var VERSION = "1.4.8-step73-observability.1";
    var STYLE_ID = "dsh-voice-plugin-style";

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = [
        ".dsh-voice-button{position:relative;width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;",
        "flex:0 0 auto;border:0;border-radius:9px;background:transparent;color:inherit;cursor:pointer;",
        "transition:background-color .16s ease,color .16s ease,transform .16s ease;}",
        ".dsh-voice-button:hover{background:color-mix(in srgb,currentColor 9%,transparent);}",
        ".dsh-voice-button:active{transform:scale(.94);}",
        ".dsh-voice-button:focus-visible{outline:2px solid color-mix(in srgb,currentColor 55%,transparent);outline-offset:2px;}",
        ".dsh-voice-button[disabled]{opacity:.35;cursor:not-allowed;transform:none;}",
        ".dsh-voice-button[data-state=recording]{color:#dc4b45;background:rgba(220,75,69,.10);}",
        ".dsh-voice-button[data-error=true]{color:#b45309;}",
        ".dsh-voice-pulse{position:absolute;right:3px;top:3px;width:5px;height:5px;border-radius:50%;",
        "background:#dc4b45;box-shadow:0 0 0 0 rgba(220,75,69,.45);animation:dsh-voice-pulse 1.4s ease-out infinite;}",
        "@keyframes dsh-voice-pulse{70%{box-shadow:0 0 0 5px rgba(220,75,69,0)}100%{box-shadow:0 0 0 0 rgba(220,75,69,0)}}",
        "@media (prefers-reduced-motion:reduce){.dsh-voice-button,.dsh-voice-pulse{transition:none;animation:none;}}"
      ].join("");
      document.head.appendChild(style);
    }

    function voiceBridgeBases() {
      var loc = typeof location !== "undefined"
        ? location
        : { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:3080" };
      var proto = loc.protocol === "https:" ? "https:" : "http:";
      var host = loc.hostname || "127.0.0.1";
      var origin = loc.origin || proto + "//" + host;
      var out = [];
      if (proto === "https:") out.push(origin.replace(/\/$/, "") + "/dsh-voice");
      out.push(proto + "//" + host + ":7861");
      if (host !== "127.0.0.1" && host !== "localhost") out.push("http://127.0.0.1:7861");
      if (host !== "100.70.241.41") out.push(proto + "//100.70.241.41:7861");
      return out;
    }

    function voiceBridgeBase() {
      return voiceBridgeBases()[0];
    }

    // TTS status reporting (voice-turn-director step 1, studio project
    // 1919333): closes the "did my <spoken> block actually get read" gap and
    // is the prerequisite signal for real barge-in (the model needs to know
    // a clip was interrupted, and how much of it played, not just that the
    // block was queued). Fire-and-forget by design -- a lost status report
    // must never affect playback, so failures are swallowed silently.
    function reportTtsStatus(event) {
      // Local observation remains available if the bridge POST is unavailable.
      // Neither observation nor delivery is proof that anything was heard.
      try { window.dispatchEvent(new CustomEvent("dsh-voice-status", { detail: event })); } catch (_error) {}
      try {
        fetch(voiceBridgeBase() + "/tts-status", {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
          keepalive: true
        }).catch(function () {});
      } catch (_error) {}
    }

    // Correlated dictation trace (voice-turn-director step 11, streaming
    // dictation). Every event carries the segment id minted by the speech-stack
    // machine at recorder start (`seg`; the bridge mints `br-*` when absent) plus
    // WHO owned the mic at that moment (`owner` = this tab, `lease` = the tab
    // holding the same-origin dictation lease), so a dropped/duplicate segment
    // can be pinned to a tab. Ring buffer for the console
    // (`window.__dshVoiceTrace`) and a fire-and-forget POST to the bridge, whose
    // journal lines (`voice-trace ...`, bridge_ingress/proxy/relay/response) use
    // the same id. Never affects dictation: every failure is swallowed.
    var VOICE_TRACE_KEEP = 400;
    function traceVoice(ev, fields) {
      try {
        var lease = null;
        try {
          var held = JSON.parse(window.localStorage.getItem("dsh.dictation.lease") || "null");
          lease = held && held.client || null;
        } catch (_error) {}
        var event = { t: Date.now(), ev: String(ev), owner: myClientId() || null, lease: lease };
        for (var key in (fields || {})) if (Object.prototype.hasOwnProperty.call(fields, key)) {
          if (key !== "t" && key !== "ev") event[key] = fields[key];
        }
        var ring = window.__dshVoiceTrace || (window.__dshVoiceTrace = []);
        ring.push(event);
        if (ring.length > VOICE_TRACE_KEEP) ring.splice(0, ring.length - VOICE_TRACE_KEEP);
        fetch(voiceBridgeBase() + "/voice-trace", {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events: [event] }),
          keepalive: true
        }).catch(function () {});
      } catch (_error) {}
    }

    // Voice Turn Director (studio project 1919333 step 4): the three
    // post-interrupt behaviors (decision 72878), driven by the director
    // verdict the route already computed. turn_complete / backchannel / noise
    // need no TTS action here — turn_complete presses send via onCommit; the
    // others never commit (voice_director.commits), so this is the only hook
    // that sees them. Fed by onSegment (legacy JSON) or onVerdict (NDJSON).
    function applyDirector(director) {
      if (!director) return; // additive: no verdict, no action
      var queue = window.__dshTtsQueue;
      if (!queue) return; // nothing is speaking; no TTS to act on
      if (director.choice === "wait_stop") {
        // Hard stop, hold. Preserve an already interrupted sentence for a
        // later explicit cue; never restart it automatically.
        if (queue.hold) queue.hold();
        else queue.cancel();
      } else if (director.choice === "resume") {
        // Back up one sentence, repeat, continue (decision 72878) —
        // resume() itself cancels first, then re-speaks.
        if (queue.resume) queue.resume();
        else queue.cancel();
      } else if (director.choice === "redirect") {
        // Say NOTHING. No filler acknowledgement. Cancel the in-flight
        // response; the resulting `interrupted` tts-status event (step
        // 1) carries spokenSoFar into the model's next turn so it can
        // respond fresh to what was actually heard vs. the new input.
        queue.cancel();
      }
    }

    function loadScript(src) {
      return new Promise(function (resolve, reject) {
        var script = document.createElement("script");
        script.src = src;
        script.async = true;
        script.onload = function () { resolve(); };
        script.onerror = function () { reject(new Error("failed to load " + src)); };
        document.head.appendChild(script);
      });
    }

    function loadPhoneChat() {
      if (window.ForageSpeech && window.PhoneChat && typeof window.PhoneChat.createDictationMachine === "function") {
        return Promise.resolve(window.PhoneChat);
      }
      if (window.__dshPhoneChatLoading) return window.__dshPhoneChatLoading;
      var speech = loadScript("https://forage.ink/static/speech-stack.js?v=2026-09-27.2")
        .catch(function () { return loadScript(voiceBridgeBase() + "/speech-stack.js?v=2026-09-27.2"); });
      window.__dshPhoneChatLoading = speech
        .then(function () {
          return loadScript("https://forage.ink/static/phonechat.js?v=2026-09-27.2")
            .catch(function () { return loadScript(voiceBridgeBase() + "/phonechat.js?v=2026-09-27.2"); });
        })
        .then(function () {
          if (!window.ForageSpeech) throw new Error("speech-stack.js did not load");
          if (!window.PhoneChat || typeof window.PhoneChat.createDictationMachine !== "function") {
            throw new Error("phonechat.js has no createDictationMachine");
          }
          return window.PhoneChat;
        })
        .catch(function (error) {
          window.__dshPhoneChatLoading = null;
          throw error;
        });
      return window.__dshPhoneChatLoading;
    }

    // A <spoken> tag inside code is a MENTION, not a block. Measured
    // 2026-09-22 (voice-turn-director step 1, tts-status ring buffer): the
    // model wrote "carried a `<spoken>` block" in prose, that opened a
    // block, its real </spoken> closed it, and five clips of prose plus the
    // literal "<spoken>" of the real tag were read aloud. Strip fenced and
    // inline code first so only a bare tag in prose can open a block.
    function withoutCode(text) {
      return String(text || "")
        .replace(/```[\s\S]*?(```|$)/g, " ")
        .replace(/`[^`\n]*`/g, " ");
    }

    function spokenParts(text) {
      var out = [];
      withoutCode(text).replace(/<spoken>([\s\S]*?)<\/spoken>/gi, function (_whole, inner) {
        var value = String(inner || "").replace(/\s+/g, " ").trim();
        if (value) out.push(value);
        return "";
      });
      return out;
    }

    // Voice Turn Director (studio project 1919333 step 4): "resume" backs up
    // ONE SENTENCE from where playback was cut, not to the very start of the
    // clip -- a whole re-read of a long clause is worse than losing the tail
    // of the sentence actually in progress when the interrupt landed. Splits
    // on sentence-ending punctuation followed by space/end; deliberately
    // coarse (no abbreviation/decimal handling) because the input is TTS's
    // own already-planned clause text, not arbitrary prose.
    function splitSentences(text) {
      var out = [];
      String(text || "").replace(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g, function (m) {
        var value = m.trim();
        if (value) out.push(value);
        return "";
      });
      return out;
    }

    // Drop the LAST sentence from spokenSoFar (the one interrupted mid-way,
    // or the last one that landed clean) so it is repeated rather than
    // skipped, then reattach whatever text had not been heard yet.
    //
    // repeat + remainder are usually two HALVES OF ONE WORD split by the
    // interrupt (e.g. heard "...Part tw", unheard "o continues...") -- join
    // those WITHOUT a space, or the resumed text reads "Part tw o continues"
    // with a phantom gap. splitSentences() trims each sentence, which erases
    // the very trailing-whitespace signal that decides this, so the
    // word-boundary check below reads the ORIGINAL untrimmed spokenSoFar,
    // never the trimmed `repeat`.
    function backUpOneSentence(spokenSoFar, remainder) {
      var original = String(spokenSoFar || "");
      var sentences = splitSentences(original);
      var backTo = sentences.length ? sentences.slice(0, -1).join(" ") : "";
      var repeat = sentences.length ? sentences[sentences.length - 1] : original;
      var rest = String(remainder || "");
      // A real word boundary means EITHER side already has whitespace at the
      // seam (original ends in a space, or rest starts with one); the cut
      // is mid-word only when NEITHER does, and that is the one case that
      // must NOT get a space inserted.
      var midWord = repeat && rest && !/\s$/.test(original) && !/^\s/.test(rest);
      var needsSpace = repeat && rest && !midWord;
      var resumed = (repeat + (needsSpace ? " " : "") + rest).trim();
      return { before: backTo, resumeText: resumed };
    }

    function voiceMute(on) {
      window.__dshVoiceMuted = !!on;
      if (typeof window.__dshOnVoiceMute === "function") window.__dshOnVoiceMute(!!on);
    }

    function unlockAudio() {
      if (window.__dshAudioUnlocked) return;
      try {
        var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (AudioContextCtor) {
          var context = window.__dshAudioCtx || (window.__dshAudioCtx = new AudioContextCtor());
          if (context.state === "suspended" && context.resume) context.resume().catch(function () {});
          var buffer = context.createBuffer(1, 1, 22050);
          var source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          source.start(0);
        }
        var audio = new Audio();
        audio.muted = true;
        audio.playsInline = true;
        audio.setAttribute("playsinline", "true");
        var kick = audio.play();
        if (kick && typeof kick.catch === "function") kick.catch(function () {});
        window.__dshAudioUnlocked = true;
      } catch (_error) {}
    }

    // --- music ducking ------------------------------------------------------
    // Lower local music (Spotify et al) while the agent speaks. The bridge
    // ducks PipeWire streams with media.role=Music, so this is instant and
    // offline -- no Spotify Web API, no OAuth, no device-type limits, and the
    // agent's own TTS is never ducked by its own request.
    //
    // Called on the WHOLE speaking run (drain start/end), never per clip:
    // ducking per clause would pump the music up and down between phrases.
    // Failure to reach the bridge is ignored -- speech must still happen.
    var duckedNow = false;

    // --- TTS prewarm --------------------------------------------------------
    // MEASURED: the first /tts after an idle gap costs ~2.9-7.7s; warm calls
    // cost ~0.6s. There is always a pause between turns, so that cold start
    // lands on the FIRST chunk of every reply and IS the front silence.
    // Chunk size barely matters (3w 0.60s vs 17w 0.75s), so re-chunking the
    // first clause cannot fix it. Warm the path as soon as a turn starts
    // streaming -- long before the spoken text exists. Throttled, because
    // warming is only useful once per idle gap.
    var lastWarmAt = 0;
    var lastWarmKey = "";
    var WARM_MIN_GAP_MS = 15000;

    function warmTts() {
      if (!wantSpeak()) return; // muted: do not touch the backend at all
      var now = Date.now();
      if (now - lastWarmAt < WARM_MIN_GAP_MS) return;
      lastWarmAt = now;
      try {
        fetch(voiceBridgeBase() + "/tts-warm", {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        }).catch(function () {});
      } catch (_error) {}
    }

    // A drain run ends whenever the prefetch buffer is momentarily empty, which
    // on a streaming reply happens BETWEEN clauses while the next synthesis is
    // still in flight -- drain() then restarts for the remaining text. Releasing
    // the duck on that boundary is what let music swell back mid-reply. Ducking
    // ON stays immediate; ducking OFF waits out a short grace, and any re-duck
    // inside that window simply cancels the pending release.
    var UNDUCK_GRACE_MS = 1200;
    var unduckTimer = null;

    function cancelUnduck() {
      if (unduckTimer === null) return;
      try { clearTimeout(unduckTimer); } catch (_error) {}
      unduckTimer = null;
    }

    // The bridge's duck watchdog restores music if it hears nothing further
    // from this client (DSH_DUCK_WATCHDOG_S, default 20s) — that watchdog is
    // the guarantee against a crashed tab leaving music quiet forever, so it
    // must stay. But a single spoken reply can easily exceed it: a ~42s Kokoro
    // reply ducked at 23:45:14 and sent nothing until 23:45:45, so the music
    // came back up WHILE the agent was still talking.
    //
    // sendDuck() also suppresses redundant traffic, so simply re-calling
    // duckMusic(true) could not refresh it either. Hence an explicit keepalive:
    // while audio is genuinely playing, re-assert the duck comfortably inside
    // the watchdog window.
    var duckKeepalive = null;
    var DUCK_KEEPALIVE_MS = 8000;

    function startDuckKeepalive() {
      if (duckKeepalive) return;
      duckKeepalive = setInterval(function () {
        // Renew the speech lease while audio is actually sounding, so a long
        // reply cannot expire its own claim and let a second tab start up.
        try {
          if (typeof window.__dshLeaseSession === "string") {
            claimSpeechLease(window.__dshLeaseSession);
          }
        } catch (_error) {}
        // Bypass the dedupe: the point is to tell the bridge we are still here.
        try {
          fetch(voiceBridgeBase() + "/duck", {
            method: "POST",
            credentials: "omit",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ duck: true })
          }).catch(function () {});
        } catch (_error) {}
      }, DUCK_KEEPALIVE_MS);
    }

    function stopDuckKeepalive() {
      if (!duckKeepalive) return;
      clearInterval(duckKeepalive);
      duckKeepalive = null;
    }

    function duckMusic(on) {
      if (on) {
        cancelUnduck(); // a refill gap must not release the duck
        sendDuck(true);
        startDuckKeepalive();
        return;
      }
      stopDuckKeepalive();
      cancelUnduck();
      unduckTimer = setTimeout(function () {
        unduckTimer = null;
        sendDuck(false);
      }, UNDUCK_GRACE_MS);
    }

    // Release the duck NOW, skipping the grace window: an explicit stop must
    // never leave music quiet waiting on a timer.
    function duckMusicNow(on) {
      if (!on) stopDuckKeepalive();
      cancelUnduck();
      sendDuck(on);
      if (on) startDuckKeepalive();
    }

    function sendDuck(on) {
      if (!!on === duckedNow) return; // no redundant traffic
      duckedNow = !!on;
      try {
        fetch(voiceBridgeBase() + "/duck", {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ duck: !!on })
        }).catch(function () {});
      } catch (_error) {}
    }

    // --- pipelined TTS queue ------------------------------------------------
    // WHY THIS EXISTS (do not "simplify" back to ForageSpeech.createTTSQueue):
    // the shared speech-stack queue drains STRICTLY serially --
    //   while (queue) { await fetch(/tts); await play(); }
    // so synthesis of clause N+1 does not begin until clause N has finished
    // PLAYING. Measured on this bridge, one /tts call costs ~0.6-4.7s, which
    // is the same order as the clip's own duration. The result is a ~3s dead
    // gap at every clause boundary: a single paragraph took ~30s to read.
    //
    // FIX: decouple synthesis from playback. Synthesis runs ahead by
    // LOOKAHEAD clips while the current clip plays, so fetch latency hides
    // under audio that is already sounding. Playback order is still strictly
    // sequential -- only the FETCHES overlap.
    //
    // Depth is 2, not unbounded: the backend partially serializes (3 clauses
    // fanned out fully took 6.8s vs 8.9s serial -- little gain, more load),
    // and depth 2 already covers an occasional slow clause.
    //
    // speech-stack.js is served from forage.ink and SHARED with the phone
    // canvas, so it is deliberately not forked; this override is local to DSH.
    // MEASURED, do not raise: the TTS backend serializes, and concurrent
    // requests are served in an order unrelated to need. Firing 3 clauses at
    // once made the FIRST clip (the one needed immediately) finish LAST:
    //   concurrent x3 -> first audio at 8.32s   (clip0 8.32s, clip2 3.06s)
    //   sequential    -> first audio at 0.80s
    // Lookahead above 1 therefore delays speech by ~10x and strands prefetched
    // clips, which the browser then aborts (BrokenPipe 502s in the bridge log).
    // Depth 1 = synthesize the NEXT clip while the current one plays, never
    // more. Synthesis (~0.5-0.8s/clause) comfortably hides under playback.
    //
    // RAISED to 3 on 2026-09-22. The hazard above was real but has since been
    // designed out: synth() chains every request onto synthChain, so exactly
    // ONE /tts is in flight at a time and always in order, whatever the depth.
    // Verified directly (/tmp/test_lookahead.mjs): at LOOKAHEAD=3 the requests
    // still leave strictly in order with maxConcurrent=1, identical to depth 1.
    // Depth only controls how far AHEAD queueing starts, not how many fly.
    //
    // Why it had to rise: with depth 1, topUp() only starts clip N+1 once clip
    // N is PLAYING, so each clause costs playback + a full synthesis round-trip
    // SERIALLY. Measured live 2026-09-22 — uncached round-trip ~1.2-1.7s, yet
    // clips arrived 4-7s apart, and the operator heard exactly those pauses
    // ("some 4s pauses... long pauses"). Depth 3 lets synthesis run ahead so
    // the round-trip hides under audio that is already sounding.
    var LOOKAHEAD = 3;

    // PRESENTATION POLICY (operator, 2026-09-21): in a chat with a building
    // agent, time-to-first-word is NOT the constraint — smooth delivery is.
    // "if it takes longer to generate, then don't start until you know you
    // can continue." A phone call would invert this.
    //
    // The engine (chatterbox-turbo-4bit on the M1) renders at ~0.84x realtime:
    // a sentence takes ~2.6s to make and ~1.8s to speak. Playback therefore
    // drains faster than synthesis fills and the gaps are STRUCTURAL — no
    // lookahead depth can close them, because the deficit compounds per clip.
    //
    // So buffer the whole run before speaking a word. Latency to first audio
    // is traded away deliberately in exchange for zero mid-sentence stalls.
    // Flip to false only for a latency-critical surface (live phone voice).
    //
    // REFINED (operator, 2026-09-21): "in this context, a work session, the
    // likely case is I've looked away while you are working, and I will come
    // back to review your results when I hear the spoken turn — so it's not a
    // problem to have bleeding edge speed. Just co-ordinate the duck and the
    // speech, and don't have long awkward silences in a speech block."
    //
    // So the REAL requirement is not low latency at all: the duck is a
    // NOTIFICATION that pulls the operator back to the screen. It must
    // therefore land WITH the voice, never before it — a duck followed by
    // silence reads as a malfunction ("why did the music dip... waiting...").
    // Long render time is acceptable; dead air inside a spoken block is not.
    //
    // Hence: render everything, THEN duck, THEN speak, THEN restore.
    // See duckForPlayback()/restoreAfterPlayback() in drain().
    //
    // RETIRED 2026-09-22 (operator approved). The premise above — "playback
    // drains faster than synthesis fills, so the gaps are STRUCTURAL" — was
    // TRUE of chatterbox-turbo-4bit at ~0.84x realtime. It is FALSE of Kokoro.
    // Measured on the mac, 5 clauses: 4.87s of synthesis produced 22.04s of
    // audio (4.5x headroom), and EVERY clause had positive margin (+1.88s,
    // +3.83s, +4.27s, +4.21s, +2.99s). The deficit cannot compound when each
    // clip buys 2-4s of slack, so LOOKAHEAD=1 keeps ahead on its own.
    //
    // The cost of keeping it was severe and measured: tts-plan at 23:48:45 ->
    // first audio at 23:49:16 = 31s of silence before a word (observed up to
    // ~40s). The duck still lands WITH the voice — duckForPlayback() fires at
    // first playback either way — so the notification contract is preserved
    // while time-to-first-word drops to roughly one clause.
    //
    // Flip back to true if the engine is ever swapped for a sub-realtime one:
    // this flag tracks the ENGINE's realtime factor, not a taste preference.
    var BUFFER_WHOLE_REPLY = false;

    // How long an un-synthesized clause may wait before it is no longer worth
    // speaking. Generous enough to cover a slow cold render or a brief backend
    // hiccup, short enough that a recovered backend never replays a backlog of
    // stale turns. Deliberately larger than LIVE_WINDOW_MS (60s), which gates
    // whether a reply is enqueued at all; this gates whether it still plays.
    var STALE_CLIP_MS = 120000;

    // ErrorLog 54705 (2026-09-23): "music ducks but the spoken line is not
    // heard; a later clip is dropped as 'stale' after the first clip hangs
    // for about 196s." Root cause: playUrl() had NO bound on the wait for the
    // <audio> element to settle — it resolves only on the "ended" or "error"
    // DOM events. A real element can neither play, end, nor error (an
    // autoplay-permission stall, a blob/WAV decode hang, a tab that lost its
    // user-activation) and the returned promise then never resolves. step()
    // therefore never runs again: duckForPlayback() has already fired (music
    // stays ducked, matching "music ducks"), yet nothing is ever heard
    // ("the spoken line is not heard"), and every clip still queued behind
    // the frozen one keeps aging in `pending`/`prefetched` while step() is
    // blocked — so by the time anything unsticks the tab (nav away/back,
    // focus change, a later external event), STALE_CLIP_MS has long since
    // elapsed and the next block is dropped as "stale". 196s is simply
    // whatever it took for that external event to arrive; it is not this
    // constant. Reproduced directly (a stub <audio> whose play() never
    // settles and never fires ended/error): the queue never advances past
    // clip 1 and the duck never releases. Fix: bound the wait itself so a
    // hung element cannot hold the queue (and the duck) hostage — mirrors
    // the existing "one bad clip must not stall the whole reply" contract
    // that synthNow() already applies to synthesis failures, extended to
    // playback failures that never surface a DOM event at all.
    var CLIP_PLAY_TIMEOUT_MS = 20000;

    function createPipelinedQueue(config) {
      // Resolve the status reporter defensively: this function is also
      // injected into the test harnesses (test_*.mjs) via new Function with
      // an explicit parameter list that predates it, and status reporting is
      // observability only -- it must never be load-bearing for playback.
      var report = (typeof reportTtsStatus === "function") ? reportTtsStatus : function () {};
      // Same defensive resolution: pre-existing test_*.mjs harnesses build
      // this function via new Function() with a parameter list that predates
      // backUpOneSentence. Fall back to "repeat everything unheard" (no
      // sentence-level back-up) rather than throwing — worse UX than the real
      // helper, never broken.
      var backUp = (typeof backUpOneSentence === "function") ? backUpOneSentence
        : function (spokenSoFar, remainder) {
          return { before: "", resumeText: [spokenSoFar, remainder].filter(Boolean).join(" ").trim() };
        };
      var pending = [];      // clips awaiting synthesis
      var prefetched = [];   // { promise } in playback order, already started
      var draining = false;
      var generation = 0;
      // The queue spans turns; a higher numeric turn supersedes queued speech.
      var activeTurn = null; // { sessionId, turn }
      // A block with any dropped clip must not be reported as fully heard.
      var incompleteBlockKeys = new Set();
      var heardBlockKey = null;
      var heardBlockPrefix = "";
      var bargeSnapshot = null; // interrupted speech, eligible for resume for 60 seconds
      var blockedTurn = null; // late blocks from the interrupted turn stay dropped
      var activeAudio = null;
      var activeMeta = null;   // meta of the clip currently sounding, for resume()
      var finishActive = null;
      var idleWaiters = [];
      var planChain = Promise.resolve();
      var synthChain = Promise.resolve();
      var duckedThisRun = false;

      // Voice Turn Director (studio project 1919333 step 4). live() reports
      // what THIS run is doing right now: is anything sounding, and if so,
      // an estimate of what has been heard so far plus whatever text (this
      // clip's remainder + every clip still queued behind it) has not been
      // spoken yet. Read at dictation-upload time (opts.assistantSpeaking /
      // opts.spokenSoFar below), never cached, so it can never go stale.
      function liveCurrentClipSpoken() {
        if (!activeAudio || !activeMeta) return "";
        var ratio = (activeAudio.duration && isFinite(activeAudio.duration) && activeAudio.duration > 0)
          ? Math.min(1, (activeAudio.currentTime || 0) / activeAudio.duration)
          : 0;
        var text = activeMeta.text || "";
        return text.slice(0, Math.round(text.length * ratio));
      }

      function liveSpokenSoFar() {
        if (!activeAudio || !activeMeta) return "";
        return [heardBlockPrefix, liveCurrentClipSpoken()].filter(Boolean).join(" ");
      }

      function liveUnspokenRemainder() {
        var head = "";
        if (activeAudio && activeMeta) {
          var spoken = liveCurrentClipSpoken();
          head = (activeMeta.text || "").slice(spoken.length);
        }
        var queued = prefetched.map(function (e) { return e.meta && e.meta.text; })
          .concat(pending.map(function (p) { return p && p.text ? p.text : p; }))
          .filter(Boolean);
        return [head].concat(queued).filter(Boolean).join(" ").trim();
      }

      function live() {
        return {
          speaking: !!(activeAudio && activeMeta),
          spokenSoFar: liveSpokenSoFar(),
          unspokenRemainder: liveUnspokenRemainder(),
          meta: activeMeta
        };
      }

      function settleIdle() {
        var waiters = idleWaiters;
        idleWaiters = [];
        waiters.forEach(function (resolve) { resolve(); });
      }

      function whenIdle() {
        if (!draining && !pending.length && !prefetched.length) return Promise.resolve();
        return new Promise(function (resolve) { idleWaiters.push(resolve); });
      }

      // Synthesis only: returns a blob URL, never touches the speaker.
      //
      // Every clip is chained onto synthChain so at most ONE /tts request is
      // in flight at a time. This is load-bearing: the backend serializes and
      // returns concurrent requests out of order, so firing several at once
      // made the clip needed FIRST arrive LAST (measured 8.32s vs 0.80s).
      // Buffering the whole reply queues many clips at once, which makes this
      // guarantee matter more, not less.
      function synth(text, token) {
        var result = synthChain.then(function () {
          if (token !== generation) return null;
          return synthNow(text, token);
        });
        synthChain = result.catch(function () { return null; });
        return result;
      }

      function synthNow(text, token) {
        // RETRY ONCE. A clip that fails upstream used to resolve null, which
        // skipped playUrl and ended the whole run: the music ducked, nothing
        // was ever spoken, and it unducked again. On a single-clause reply
        // that is TOTAL SILENCE with no error shown to the user.
        function attempt(triesLeft) {
          return fetch(config.ttsEndpoint, {
            method: "POST",
            credentials: "omit",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: text, voice: config.voice })
          }).then(function (response) {
            if (token !== generation) return null;
            if (!response.ok) {
              if (triesLeft > 0) return attempt(triesLeft - 1);
              console.warn("[dsh-voice] tts clip failed", response.status);
              return null;
            }
            return response.arrayBuffer().then(function (bytes) {
              if (token !== generation) return null;
              if (!bytes.byteLength) {
                if (triesLeft > 0) return attempt(triesLeft - 1);
                return null;
              }
              var type = (response.headers.get("Content-Type") || "audio/wav").split(";")[0];
              return URL.createObjectURL(new Blob([bytes], { type: type }));
            });
          }).catch(function (error) {
            if (token !== generation) return null;
            if (triesLeft > 0) return attempt(triesLeft - 1);
            console.warn("[dsh-voice] tts synth", error && error.message ? error.message : error);
            return null; // one bad clip must not stall the whole reply
          });
        }
        return attempt(1);
      }

      // Keep the synthesis window full so the next clip is already in flight.
      // Under BUFFER_WHOLE_REPLY the window is the whole reply: every clause
      // is synthesized before the first one is played. Requests still leave
      // ONE AT A TIME (see synthChain) because the backend serializes and
      // reorders concurrent work.
      function topUp(token) {
        var room = BUFFER_WHOLE_REPLY ? Infinity : LOOKAHEAD;
        while (prefetched.length < room && pending.length) {
          if (token !== generation) return;
          var item = pending.shift();
          var text = item && item.text ? item.text : item;
          var at = item && typeof item.at === "number" ? item.at : Date.now();
          var meta = {
            text: text,
            sessionId: item && item.sessionId,
            key: item && item.key,
            blockText: item && item.blockText,
            clipIndex: item && item.clipIndex,
            clipCount: item && item.clipCount
          };
          prefetched.push({ at: at, meta: meta, promise: synth(text, token) });
        }
      }

      function playUrl(url, meta) {
        return new Promise(function (resolve) {
          var audio = new Audio(url);
          if (meta && meta.key !== heardBlockKey) { heardBlockKey = meta.key; heardBlockPrefix = ""; }
          activeAudio = audio;
          activeMeta = meta || null;
          audio.playsInline = true;
          try {
            if (window.__dshSoundPresence) window.__dshSoundPresence.attachTTS(audio);
          } catch (_error) {}
          window.__dshTtsCurrent = audio;
          var settled = false;
          var reportedStart = false;
          function reportEnd(ended, reason) {
            // spokenSoFar: how much of THIS clip's text had already been
            // heard when it stopped, estimated by playback-time ratio. Not
            // exact (TTS pacing is not perfectly linear) but good enough for
            // "resume: back up one sentence" and "redirect: what did Nate
            // actually hear" -- both need an estimate, not word-level truth.
            var ratio = (audio.duration && isFinite(audio.duration) && audio.duration > 0)
              ? Math.min(1, (audio.currentTime || 0) / audio.duration)
              : (ended ? 1 : 0);
            var text = (meta && meta.text) || "";
            var spokenSoFar = ended ? text : [heardBlockPrefix, text.slice(0, Math.round(text.length * ratio))].filter(Boolean).join(" ");
            if (ended) heardBlockPrefix = [heardBlockPrefix, text].filter(Boolean).join(" ");
            report({
              event: ended ? "clip_end" : "interrupted",
              sessionId: (meta && meta.sessionId) || "",
              key: (meta && meta.key) || "",
              text: text,
              clipIndex: meta && meta.clipIndex,
              clipCount: meta && meta.clipCount,
              spokenSoFar: spokenSoFar,
              reason: ended ? undefined : (reason || "cancelled")
            });
          }
          var watchdog = null;
          function clearWatchdog() {
            if (watchdog === null) return;
            try { clearTimeout(watchdog); } catch (_error) {}
            watchdog = null;
          }
          function done(ended, reason) {
            if (settled) return;
            settled = true;
            clearWatchdog();
            if (activeAudio === audio) { activeAudio = null; activeMeta = null; }
            if (finishActive === done) finishActive = null;
            if (window.__dshTtsCurrent === audio) window.__dshTtsCurrent = null;
            try {
              if (window.__dshSoundPresence) window.__dshSoundPresence.ttsClipEnded();
            } catch (_error) {}
            reportEnd(ended === true, reason);
            URL.revokeObjectURL(url);
            resolve(ended === true);
          }
          finishActive = function (reason) { done(false, reason); }; // cancel() path: not a natural end
          audio.addEventListener("ended", function () { done(true); });
          audio.addEventListener("error", function () { done(false); });
          if (meta && !reportedStart) {
            reportedStart = true;
            report({
              event: "clip_start",
              sessionId: (meta && meta.sessionId) || "",
              key: (meta && meta.key) || "",
              text: (meta && meta.text) || "",
              clipIndex: meta && meta.clipIndex,
              clipCount: meta && meta.clipCount
            });
          }
          // PLAYBACK WATCHDOG (ErrorLog 54705). Neither "ended" nor "error"
          // is guaranteed: a stalled autoplay permission, a blob/WAV decode
          // hang, or a tab that lost user-activation can leave the element
          // sounding nothing forever with no DOM event ever firing. Without
          // a bound here, this promise never settles, step() never runs
          // again, the duck (already fired below by the caller) never
          // releases, and every clip still queued behind this one ages past
          // STALE_CLIP_MS and is silently dropped once something unrelated
          // eventually unsticks the tab. Treat a clip that neither ends nor
          // errors within CLIP_PLAY_TIMEOUT_MS as failed play — not "ended
          // true", so reportEnd() emits the honest partial-spokenSoFar
          // "interrupted" shape (same as a cancel) instead of falsely
          // claiming the text was heard.
          // Resolve defensively, same as staleMs below: this function is also
          // injected into pre-existing test_*.mjs harnesses via new Function()
          // with an explicit parameter list that predates this constant, so a
          // free-variable read there is undefined rather than the real value.
          var clipTimeoutMs = typeof CLIP_PLAY_TIMEOUT_MS === "number" ? CLIP_PLAY_TIMEOUT_MS : 20000;
          watchdog = setTimeout(function () {
            console.warn("[dsh-voice] tts clip play watchdog fired (no ended/error within "
              + clipTimeoutMs + "ms)");
            try { audio.pause(); } catch (_error) {}
            done(false);
          }, clipTimeoutMs);
          var started = audio.play();
          if (started && started.catch) started.catch(function () { done(false); });
        });
      }

      function drain() {
        if (draining) return;
        draining = true;
        // Keep the echo-cancelled dictation stream open for local barge-in.
        var token = generation;

        // The duck must bracket AUDIO, not synthesis. Ducking when the run
        // starts meant the music dropped the moment planning began and stayed
        // down through the entire buffered synthesis — measured 13s of quiet
        // music before the first word. Duck on the first clip that actually
        // plays; restore only after the last one has finished sounding.
        // duckedThisRun lives at QUEUE scope (not here): drain() re-enters
        // itself when a late block arrives, and a per-call flag would lose
        // the fact that the music is already down.
        function duckForPlayback() {
          if (duckedThisRun) return;
          duckedThisRun = true;
          duckMusic(true);
        }

        function restoreAfterPlayback() {
          if (!duckedThisRun) return;
          duckedThisRun = false;
          duckMusic(false);
        }

        // Buffered presentation: synthesize EVERYTHING first, then speak.
        // The engine renders slower than realtime, so starting early
        // guarantees a stall mid-reply; waiting guarantees a clean read.
        function ready() {
          if (!BUFFER_WHOLE_REPLY) return Promise.resolve();
          topUp(token);
          return Promise.all(prefetched.map(function (entry) { return entry.promise; }))
            .then(function () {
              // A late-arriving block may have queued more while we waited.
              if (token === generation && pending.length) return ready();
            });
        }

        ready().then(function () { step(); });

        function step() {
          if (token !== generation) return; // a newer turn owns the shared queue
          topUp(token); // refill BEFORE awaiting, so the next fetch overlaps this clip
          if (!prefetched.length) {
            draining = false;
            voiceMute(false);
            if (token === generation && (pending.length || prefetched.length)) {
              // More audio is still coming: keep the music down rather than
              // bouncing it up between blocks of the same reply.
              drain();
            } else {
              restoreAfterPlayback();
              incompleteBlockKeys.clear();
              heardBlockKey = null; heardBlockPrefix = "";
              settleIdle();
            }
            return;
          }
          var next = prefetched.shift();
          // Refill IMMEDIATELY on consuming a slot, not only after playback
          // starts below. step() runs once per clip and is gated on the
          // previous clip FINISHING, so with the refill only at line ~566 the
          // window regained at most one slot per playback cycle and never
          // actually ran LOOKAHEAD deep: measured 4-8s gaps against a ~1.1s
          // synthesis, with the backend sitting idle between clips. Topping up
          // here lets the depth be real, and synthChain still guarantees the
          // requests leave one at a time in order.
          topUp(token);
          // STALE-BACKLOG GUARD. A clip that cannot be synthesized is skipped
          // rather than ending the run (see synthNow), and BUFFER_WHOLE_REPLY
          // pulls the entire reply into `prefetched` up front. So a TTS outage
          // leaves already-queued clips sitting here with failed/slow synthesis.
          // When the backend recovered (engine swapped to Kokoro) the whole
          // session's backlog drained at once and the operator heard every
          // <spoken> block replayed back-to-back. Speech is only worth hearing
          // while it is current: age is the honest test, the same principle
          // LIVE_WINDOW_MS applies to history. Checked HERE, at the moment of
          // playback, because that is when "too late to be worth saying" is
          // actually true.
          // Resolve defensively: this function is also injected into test
          // harnesses (and could be into other hosts) with an explicit
          // parameter list that predates this constant.
          var staleMs = typeof STALE_CLIP_MS === "number" ? STALE_CLIP_MS : 120000;
          if (next && typeof next.at === "number" &&
              Date.now() - next.at > staleMs) {
            if (next.meta && next.meta.key) incompleteBlockKeys.add(next.meta.key);
            report({
              event: "clip_failed",
              sessionId: (next.meta && next.meta.sessionId) || "",
              key: (next.meta && next.meta.key) || "",
              text: (next.meta && next.meta.text) || "",
              reason: "stale"
            });
            next.promise.then(function (url) { if (url) URL.revokeObjectURL(url); }, function () {});
            step();
            return;
          }
          next.promise.then(function (url) {
            if (token !== generation) { if (url) URL.revokeObjectURL(url); return null; }
            // A clip that could not be synthesized must NOT end the run: keep
            // the queue moving so the remaining clauses are still spoken.
            if (!url) {
              if (next.meta && next.meta.key) incompleteBlockKeys.add(next.meta.key);
              report({
                event: "clip_failed",
                sessionId: (next.meta && next.meta.sessionId) || "",
                key: (next.meta && next.meta.key) || "",
                text: (next.meta && next.meta.text) || "",
                reason: "synth_failed"
              });
              topUp(token);
              return null;
            }
            // Sound is about to come out of the speaker: duck now, not when
            // the run began. playUrl resolves when the clip ENDS, so the
            // restore below cannot fire while audio is still sounding.
            duckForPlayback();
            // Start the NEXT synthesis only once this clip is actually
            // PLAYING, never while it is still downloading. Overlapping two
            // /tts requests makes the backend serve them out of order, so the
            // clip needed first arrives last (measured 8.32s vs 0.80s).
            var playing = playUrl(url, next.meta);
            topUp(token);
            return playing;
          }).then(function (ended) {
            if (token !== generation) return;
            var key = next.meta && next.meta.key;
            if (ended === false && key) incompleteBlockKeys.add(key);
            if (ended === true && next.meta.clipIndex === next.meta.clipCount - 1) {
              if (!incompleteBlockKeys.has(key)) {
                report({ event: "block_complete", sessionId: next.meta.sessionId, key: key, text: next.meta.blockText });
              }
              incompleteBlockKeys.delete(key);
            }
            step();
          }, function () { step(); });
        }
      }

      // sessionId/key identify the SOURCE <spoken> block (spokenKey(part) —
      // text identity, see client.js dedup comment) so status events are
      // attributable back to a specific block, not just a clip index.
      // Pulled out of the returned `enqueue` so resume() (voice-turn-director
      // step 4) can re-enter it after cancel() without duplicating the plan
      // -> pending -> drain wiring.
      function enqueueText(text, sessionId, key, turn) {
        if (blockedTurn && typeof turn === "number") {
          if (blockedTurn.sessionId === sessionId && turn <= blockedTurn.turn) return Promise.resolve();
          blockedTurn = null;
        }
        // A late settled node may follow a newer partial; compare numeric turns.
        // Missing turn (resume/legacy caller) continues the current run.
        if (typeof turn === "number" && activeTurn && activeTurn.sessionId === sessionId
            && turn < activeTurn.turn) {
          return Promise.resolve(); // stale turn: never queue behind newer speech
        }
        if (typeof turn === "number") {
          if (activeTurn && activeTurn.sessionId === sessionId) {
            if (turn > activeTurn.turn) {
              cancelNow();
              activeTurn = { sessionId: sessionId, turn: turn };
            }
          } else {
            if (activeTurn) cancelNow(); // a new session cannot inherit the old queue or barge snapshot
            activeTurn = { sessionId: sessionId, turn: turn };
          }
        }
        var requestGeneration = generation;
        // planChain orders PLANNING only, so blocks keep their spoken order.
        // It must never await playback: chaining whenIdle() in here made
        // block N+1's /tts-plan wait for block N to finish SPEAKING, which
        // re-introduced exactly the serial stall this queue exists to remove.
        planChain = planChain.then(function () {
          if (requestGeneration !== generation) return;
          return fetch(config.planEndpoint, {
            method: "POST",
            credentials: "omit",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(Object.assign({ text: String(text || "") }, config.surfaceSignals && config.surfaceSignals()))
          }).then(function (response) {
            if (!response.ok) throw new Error("tts plan " + response.status);
            return response.json();
          }).then(function (body) {
            if (requestGeneration !== generation) return;
            var enqueuedAt = Date.now();
            var chunks = (body.chunks || []).map(function (c) { return String(c).trim(); })
              .filter(function (c) { return c; });
            chunks.forEach(function (chunk, index) {
              pending.push({
                text: chunk, at: enqueuedAt,
                sessionId: sessionId, key: key, blockText: String(text || ""),
                clipIndex: index, clipCount: chunks.length
              });
            });
            drain();
          });
        }).catch(function (error) {
          console.warn("[dsh-voice] tts", error && error.message ? error.message : error);
        });
        // Keep the public completion promise; block_complete is reported by
        // step() only after this block's final clip actually ends.
        return planChain.then(whenIdle);
      }

      function cancelNow(reason) {
        bargeSnapshot = reason === "barge_in" ? Object.assign({ at: Date.now() }, live()) : null;
        if (reason === "barge_in") blockedTurn = activeTurn;
        generation++;
        pending = [];
        prefetched = [];
        incompleteBlockKeys.clear();
        if (activeAudio) { try { activeAudio.pause(); } catch (_error) {} }
        if (finishActive) finishActive(reason);
        heardBlockKey = null; heardBlockPrefix = "";
        draining = false;
        voiceMute(false);
        // Stopping speech must never leave the music quiet. Clear the flag
        // too, so the next run ducks again instead of thinking it already has.
        duckedThisRun = false;
        duckMusic(false);
        settleIdle();
      }

      return {
        enqueue: enqueueText,
        cancel: cancelNow,
        hold: function () {
          if (bargeSnapshot && this.hasBargeForSession(bargeSnapshot.meta && bargeSnapshot.meta.sessionId)) return;
          cancelNow(activeAudio ? "barge_in" : undefined);
        },
        whenIdle: whenIdle,
        isSpeaking: function () { return draining; },
        // Voice Turn Director (studio project 1919333 step 4): live playback
        // state for the dictation upload (assistant_speaking + spoken_so_far)
        // and the "resume" behavior below.
        live: live,
        hasBargeForSession: function (sessionId) {
          if (bargeSnapshot && Date.now() - bargeSnapshot.at > 60000) bargeSnapshot = null;
          return !!(bargeSnapshot && bargeSnapshot.speaking && bargeSnapshot.meta
            && bargeSnapshot.meta.sessionId === sessionId);
        },
        forgetBargeForSession: function (sessionId) {
          if (bargeSnapshot && (!bargeSnapshot.meta || bargeSnapshot.meta.sessionId !== sessionId)) bargeSnapshot = null;
          if (blockedTurn && blockedTurn.sessionId !== sessionId) blockedTurn = null;
        },
        // "resume" (decision 72878): NOT a bare replay. Capture what has and
        // has not been heard of the interrupted clip plus everything still
        // queued behind it, hard-stop (cancel — never silently resume the
        // SAME in-flight response, principle 72880), back up one sentence
        // from what was heard, and re-speak that sentence plus the unheard
        // remainder as a fresh block under the SAME sessionId/key so status
        // events still attribute to the original block.
        resume: function () {
          var snapshot = live();
          if (!snapshot.speaking && bargeSnapshot && this.hasBargeForSession(bargeSnapshot.meta && bargeSnapshot.meta.sessionId)) snapshot = bargeSnapshot;
          var sessionId = snapshot.meta && snapshot.meta.sessionId;
          var key = snapshot.meta && snapshot.meta.key;
          cancelNow();
          if (!snapshot.speaking) return Promise.resolve();
          var backed = backUp(snapshot.spokenSoFar, snapshot.unspokenRemainder);
          var resumeText = backed.resumeText;
          if (!resumeText) return Promise.resolve();
          return enqueueText(resumeText, sessionId, key);
        }
      };
    }

    // --- current-tab signals (Nate 2026-09-29) ------------------------------
    // Every /tts-plan carries these so the bridge can give a <spoken> block to
    // the surface the human is USING (focused+visible, latest interaction) and
    // no other. The id is per TAB (sessionStorage): __dshClientId is per device,
    // so two tabs of one origin would look like one surface.
    var surfaceTabId = "";
    var surfaceLastInteraction = Date.now();

    function surfaceClientId() {
      if (surfaceTabId) return surfaceTabId;
      try { surfaceTabId = window.sessionStorage.getItem("dsh.voice.tabId") || ""; } catch (_error) {}
      if (!surfaceTabId) {
        surfaceTabId = "tab-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        try { window.sessionStorage.setItem("dsh.voice.tabId", surfaceTabId); } catch (_error) {}
      }
      return surfaceTabId;
    }

    function surfaceSignals() {
      return {
        clientId: surfaceClientId(),
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        lastInteractionAt: surfaceLastInteraction,
        now: Date.now()
      };
    }

    function sendSurfaceHeartbeat() {
      try {
        fetch(voiceBridgeBase() + "/tts-surface", {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(surfaceSignals()),
          keepalive: true
        }).catch(function () {});
      } catch (_error) {}
    }

    (function installSurfaceSignals() {
      if (typeof window === "undefined" || typeof document === "undefined" || !window.addEventListener) return;
      function touch() { surfaceLastInteraction = Date.now(); }
      ["pointerdown", "keydown"].forEach(function (name) {
        window.addEventListener(name, touch, { capture: true, passive: true });
      });
      window.addEventListener("focus", function () { touch(); sendSurfaceHeartbeat(); });
      window.addEventListener("blur", sendSurfaceHeartbeat);
      window.addEventListener("pagehide", sendSurfaceHeartbeat);
      document.addEventListener("visibilitychange", sendSurfaceHeartbeat);
      setInterval(sendSurfaceHeartbeat, 10000);
      sendSurfaceHeartbeat();
    })();

    function speakQueue() {
      if (!window.__dshTtsQueue) {
        window.__dshTtsQueue = createPipelinedQueue({
          ttsEndpoint: voiceBridgeBase() + "/tts",
          planEndpoint: voiceBridgeBase() + "/tts-plan",
          surfaceSignals: surfaceSignals,
          voice: "fenn"
        });
      }
      return window.__dshTtsQueue;
    }

    // --- speaker state (independent of the microphone) ----------------------
    // __dshWantSpeak governs TTS playback of <spoken> blocks.
    // __dshWantListen governs microphone capture. They are deliberately
    // separate: the agent can speak without dictation being armed.
    var SPEAK_KEY = "dsh.voice.speak";

    function wantSpeak() {
      if (typeof window.__dshWantSpeak === "boolean") return window.__dshWantSpeak;
      var on = true; // default ON: spoken output should not require arming the mic
      // Per-device preference wins: each surface restores how IT was left.
      var device = loadDeviceState();
      if (device && typeof device.speak === "boolean") {
        on = device.speak;
      } else {
        try {
          var raw = localStorage.getItem(SPEAK_KEY);
          if (raw !== null) on = raw === "1";
        } catch (_error) {}
      }
      window.__dshWantSpeak = on;
      return on;
    }

    function setWantSpeak(on) {
      window.__dshWantSpeak = !!on;
      saveDeviceState({ speak: !!on });
      try { localStorage.setItem(SPEAK_KEY, on ? "1" : "0"); } catch (_error) {}
      if (!on) {
        try { if (window.__dshTtsStop) window.__dshTtsStop(); } catch (_error) {}
      }
      try {
        window.dispatchEvent(new CustomEvent("dsh-voice-speak-changed", { detail: { on: !!on } }));
      } catch (_error) {}
    }

    // --- active-device routing ---------------------------------------------
    // The HOST decides which surface the human is on (session/active-client,
    // fed by prompts and session.presence). The browser only compares its own
    // id against that broadcast, so this works across DEVICES — forge, tablet,
    // phone — not merely across tabs of one profile.
    // Globals published by the client runtime:
    //   __dshClientId       this surface's durable id
    //   __dshActiveClient   { [sessionId]: clientId } from the host broadcast
    //   __dshReportPresence () => void, reports human activity for this session

    function myClientId() {
      return String(window.__dshClientId || "");
    }

    /**
     * May this device act (speak / capture) for this session?
     * Unknown ownership means YES: a session nobody has claimed — an
     * autonomous turn, or a host too old to broadcast — must not go silent
     * everywhere. Silence is only ever chosen against a KNOWN other owner.
     */
    // Exactly ONE surface speaks, and it follows the human between devices.
    //
    // The old rule was "unknown ownership => speak", which is right for a lone
    // surface but wrong the moment two are open: the loopback and tailnet
    // origins of this same harness have SEPARATE sessionStorage, so neither
    // sees the other's seen-set and BOTH spoke. The operator should not have
    // to close tabs to stop an echo.
    //
    // Arbitration, in order:
    //   1. The host named an active client for this session -> only it speaks.
    //      (publishActiveClient broadcasts session/active-client; the runtime
    //      exposes __dshActiveClient + __dshClientId.)
    //   2. No host claim, but this surface is HIDDEN while another is visible
    //      -> stay silent. A backgrounded tab is never the one being read to.
    //   3. Otherwise speak. A single surface, or a genuinely autonomous turn
    //      nobody has claimed, must never be silenced everywhere.
    function ownsSpeech(sessionId) {
      var mine = myClientId();
      var map = window.__dshActiveClient;
      var owner = sessionId && map ? map[sessionId] : undefined;

      if (owner && mine) return owner === mine;

      // No authoritative owner: fall back to visibility. Speaking from a tab
      // the human cannot see is the observable bug (stale background surface
      // reading replies), so silence loses nothing when another surface is up.
      try {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
      } catch (_error) {}

      // Several VISIBLE surfaces still all returned true here, and each one
      // then planned and synthesized the whole reply. The mac serializes every
      // request on ONE gpu worker, so three surfaces made each clip ~3x slower
      // (measured 2026-09-22: 3 concurrent 3.46s vs 1.16s solo) — the operator
      // heard 9s to the first sentence and 7s pauses that are invisible when
      // probing the same path alone. __dshActiveClient is only ever READ in
      // this file; no host broadcast populates it, so step 1 never fires and
      // this is the real arbitration in practice.
      //
      // localStorage IS shared across same-origin tabs, so use it as a short
      // lease: first visible surface to claim the session speaks, the rest
      // stay silent (and therefore never synthesize). The lease is renewed
      // while speaking and expires quickly, so closing the winning tab hands
      // speech to another surface instead of going permanently silent.
      // Defensive: ownsSpeech() is also injected into test harnesses with an
      // explicit parameter list that predates the lease.
      if (typeof claimSpeechLease !== "function") return true;
      return claimSpeechLease(sessionId);
    }

    // Cross-tab speech lease. Same-origin only, which is exactly the case that
    // matters (several tabs on 127.0.0.1); the loopback-vs-tailnet split is
    // already handled by the visibility rule above.
    var SPEECH_LEASE_MS = 15000;

    function claimSpeechLease(sessionId) {
      var mine = myClientId();
      if (!sessionId || !mine) return true;
      var key = "dsh.speech.lease." + sessionId;
      try {
        var now = Date.now();
        var raw = window.localStorage.getItem(key);
        var held = raw ? JSON.parse(raw) : null;
        if (held && held.client !== mine && (now - held.at) < SPEECH_LEASE_MS) {
          return false; // another visible surface owns this reply
        }
        window.localStorage.setItem(key, JSON.stringify({ client: mine, at: now }));
        return true;
      } catch (_error) {
        return true; // storage unavailable: never silence the only surface
      }
    }

    // Human activity -> presence report, throttled. The host coalesces too,
    // but there is no reason to spend a request per keystroke.
    var PRESENCE_MIN_MS = 4000;
    var lastPresenceAt = 0;

    function reportPresence() {
      var now = Date.now();
      if (now - lastPresenceAt < PRESENCE_MIN_MS) return;
      lastPresenceAt = now;
      try { if (window.__dshReportPresence) window.__dshReportPresence(); } catch (_error) {}
    }

    function installPresenceListeners() {
      if (window.__dshPresenceInstalled) return;
      window.__dshPresenceInstalled = true;
      ["keydown", "pointerdown", "touchstart", "focus"].forEach(function (type) {
        window.addEventListener(type, reportPresence, { capture: true, passive: true });
      });
      // Swapping devices must MOVE the speaker, without typing anything.
      // Becoming visible is the human arriving at this surface, so claim the
      // session immediately — otherwise the previously-active machine keeps
      // ownership and reads replies to an empty room.
      try {
        document.addEventListener("visibilitychange", function () {
          if (document.visibilityState === "visible") {
            lastPresenceAt = 0; // bypass the throttle: a device swap is urgent
            reportPresence();
          }
        });
      } catch (_error) {}
    }

    // --- per-device voice state --------------------------------------------
    // Each surface remembers its OWN speak/listen preference, so walking to
    // the tablet restores how the tablet was left, not how forge was left.
    function deviceStateKey() {
      return "dsh.voice.state." + (myClientId() || "local");
    }

    function loadDeviceState() {
      try {
        var raw = localStorage.getItem(deviceStateKey());
        if (raw) return JSON.parse(raw);
      } catch (_error) {}
      return null;
    }

    function saveDeviceState(patch) {
      var current = loadDeviceState() || {};
      var next = Object.assign({}, current, patch);
      try { localStorage.setItem(deviceStateKey(), JSON.stringify(next)); } catch (_error) {}
      return next;
    }

    function seenSet() {
      if (window.__dshSpokenSeen) return window.__dshSpokenSeen;
      var set = new Set();
      try {
        var raw = sessionStorage.getItem("dsh.spoken.seen");
        if (raw) JSON.parse(raw).forEach(function (value) { if (value) set.add(String(value)); });
      } catch (_error) {}
      window.__dshSpokenSeen = set;
      return set;
    }

    function rememberSpoken(id) {
      var set = seenSet();
      if (set.has(id)) return false;
      set.add(id);
      try {
        sessionStorage.setItem("dsh.spoken.seen", JSON.stringify(Array.from(set).slice(-240)));
      } catch (_error) {}
      return true;
    }

    // Dedupe on the spoken TEXT ALONE, never on position.
    //
    // A streaming turn re-renders on every token, so the SAME finished
    // <spoken> sentence arrives repeatedly under a SHIFTING key: the block
    // index grows while text streams, and when the turn settles the node's
    // turn/step replaces the partial's. Keying on position therefore let one
    // sentence through many times — a single reply fired 16 /tts calls for
    // ~5 sentences and the operator heard everything two or three times.
    //
    // Text IS the identity of an utterance. Deliberately repeating a sentence
    // verbatim is rare; silencing the echo is worth far more.
    function spokenKey(part) {
      return String(part);
    }

    function markSpoken(text, _key) {
      spokenParts(text).forEach(function (part) { rememberSpoken(spokenKey(part)); });
    }

    function playSpoken(text, key, sessionId, turn) {
      var parts = spokenParts(text);
      if (!parts.length) return;
      // Speaking out and listening in are INDEPENDENT capabilities. The agent
      // may speak whenever it chooses; arming dictation is a separate act.
      // Only the speaker toggle silences playback.
      // A tab that did not submit stays silent so the reply does not echo from
      // every open DSH — but it still marks the text heard, so switching tabs
      // later cannot replay it.
      var speakerEnabled = wantSpeak();
      var speechOwned = speakerEnabled && ownsSpeech(sessionId);
      if (!speakerEnabled || !speechOwned) {
        parts.forEach(function (part) {
          var partKey = spokenKey(part);
          if (rememberSpoken(partKey)) reportTtsStatus({
            event: "block_skipped", sessionId: sessionId, key: key || partKey, turn: turn,
            reason: !speakerEnabled ? "speaker-disabled" : "not-speech-owner"
          });
        });
        return;
      }
      // Remember which session this surface won, so the duck keepalive can
      // renew the lease for as long as this reply is still speaking.
      try { window.__dshLeaseSession = String(sessionId || ""); } catch (_error) {}
      // Speaking no longer waits on phonechat.js/speech-stack.js: the queue is
      // self-contained, so the first clause starts synthesizing immediately
      // instead of after two remote script loads. loadPhoneChat() is still
      // required for DICTATION (createDictationMachine) and stays on that path.
      var newlyAttempted = false;
      try {
        var queue = speakQueue();
        parts.forEach(function (part) {
          var partKey = spokenKey(part);
          if (rememberSpoken(partKey)) { newlyAttempted = true; queue.enqueue(part, sessionId, partKey, turn); }
        });
      } catch (error) {
        parts.forEach(function (part) { if (rememberSpoken(spokenKey(part))) newlyAttempted = true; });
        if (newlyAttempted) reportTtsStatus({ event: "block_failed", sessionId: sessionId, key: key || spokenKey(parts[0]),
          turn: turn, reason: "queue-unavailable" });
        console.warn("[dsh-voice] tts unavailable", error);
      }
    }

    function installVoiceGlobals() {
      window.__dshVoicePluginVersion = VERSION;
      wantSpeak(); // hydrate __dshWantSpeak from this device's stored state
      installPresenceListeners();
      window.__dshSetSpeak = setWantSpeak;
      window.__dshToggleSpeak = function () { setWantSpeak(!wantSpeak()); return wantSpeak(); };
      window.__dshTtsStop = function () {
        if (window.__dshTtsQueue) window.__dshTtsQueue.cancel();
        try {
          if (window.__dshSoundPresence) window.__dshSoundPresence.ttsStopped();
        } catch (_error) {}
        window.__dshTtsCurrent = null;
        voiceMute(false);
      };
    }

    function speakerGlyph(on) {
      var children = [
        React.createElement("path", {
          key: "cone",
          d: "M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z",
          fill: "currentColor"
        })
      ];
      if (on) {
        children.push(React.createElement("path", {
          key: "w1", d: "M10.4 6.1a3 3 0 0 1 0 3.8",
          fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round"
        }));
        children.push(React.createElement("path", {
          key: "w2", d: "M12.3 4.4a5.6 5.6 0 0 1 0 7.2",
          fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round"
        }));
      } else {
        children.push(React.createElement("path", {
          key: "x1", d: "M10.6 6.2l3.2 3.6M13.8 6.2l-3.2 3.6",
          fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round"
        }));
      }
      return React.createElement(
        "svg",
        { viewBox: "0 0 16 16", width: 15, height: 15, "aria-hidden": true },
        children
      );
    }

    function SpeakerButton() {
      var initial = wantSpeak();
      var pair = React.useState(initial);
      var on = pair[0];
      var setOn = pair[1];
      React.useEffect(function () {
        function sync(event) {
          setOn(event && event.detail ? !!event.detail.on : wantSpeak());
        }
        window.addEventListener("dsh-voice-speak-changed", sync);
        return function () { window.removeEventListener("dsh-voice-speak-changed", sync); };
      }, []);
      var label = on
        ? "Spoken replies on · tap to mute"
        : "Spoken replies muted · tap to unmute";
      return React.createElement(
        "button",
        {
          type: "button",
          className: "dsh-voice-button dsh-voice-speaker",
          "data-state": on ? "on" : "off",
          "data-dsh-voice-version": VERSION,
          "aria-label": label,
          "aria-pressed": on ? "true" : "false",
          title: label,
          style: on ? undefined : { opacity: 0.45 },
          onMouseDown: function (event) { event.preventDefault(); },
          onClick: function () {
            // Browsers require a user gesture before audio may play. Turning
            // the speaker ON is that gesture, so unlock here or the first
            // spoken block is silently dropped by autoplay policy.
            var next = !wantSpeak();
            if (next) { try { unlockAudio(); } catch (_error) {} }
            setWantSpeak(next);
          }
        },
        speakerGlyph(on)
      );
    }

    function micGlyph() {
      return React.createElement(
        "svg",
        { viewBox: "0 0 16 16", width: 15, height: 15, "aria-hidden": true },
        React.createElement("rect", { x: 5.5, y: 1.5, width: 5, height: 8.5, rx: 2.5, fill: "currentColor" }),
        React.createElement("path", {
          d: "M3.5 8.5a4.5 4.5 0 0 0 9 0",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round"
        }),
        React.createElement("path", {
          d: "M8 13v1.5",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round"
        })
      );
    }

    // A reply is spoken only while it is LIVE, judged by wall-clock age.
    // Position in the node list cannot decide that: history lands
    // asynchronously (session open, switching conversations, a reload,
    // "new conversation" swapping the pane), so a first pass that ran before
    // the transcript arrived left the high-water seq at -Infinity and every
    // old answer then looked new — the whole conversation replayed aloud.
    // The host stamps each node with epoch ms; age is the honest test.
    // ponytail: 60s absorbs host/device clock skew (forge vs tablet/phone);
    // widen only if a real surface shows more drift.
    var LIVE_WINDOW_MS = 60000;

    function isLive(node) {
      return typeof node.time === "number" && Date.now() - node.time < LIVE_WINDOW_MS;
    }

    function useSpokenPlayback(session) {
      React.useEffect(function () {
        var sessionId = String(session.sessionId || "");

        // A turn is ACTIVELY streaming: warm the TTS path now, while the model
        // is still writing, so the first clause is not cold.
        //
        // The guard must be the partial's IDENTITY, not its mere presence:
        // session.partial stays populated after the turn settles and this
        // effect re-runs on every render, so `if (session.partial)` warmed the
        // backend every 15s forever — pointless load that also competed with
        // the real clip synthesis and made playback slower, not faster.
        if (session.partial) {
          var partialKey = sessionId + ":" + session.partial.turn + ":" + session.partial.step;
          if (partialKey !== lastWarmKey) {
            lastWarmKey = partialKey;
            warmTts();
          }
        }

        // Streaming text is live by definition.
        if (session.partial && Array.isArray(session.partial.blocks)) {
          session.partial.blocks.forEach(function (block, index) {
            if (block && block.kind === "text") {
              playSpoken(block.text, sessionId + ":" + session.partial.turn + ":" + session.partial.step + ":" + index, sessionId, session.partial.turn);
            }
          });
        }

        // ONLY THE NEWEST live assistant node may speak.
        //
        // isLive() alone is not enough on a REFRESH. The seen-set lives in
        // sessionStorage, so a reload starts with an empty set; every
        // assistant node still inside the 60s window then looks unheard and
        // the whole backlog is read out, oldest first. Speaking only the
        // newest node means a refresh replays at most the last reply.
        //
        // Older live nodes are still MARKED heard (never silently skipped),
        // so they cannot come back later — preserving the no-replay-on-
        // refresh guarantee (gotcha 307b3e131234).
        var nodes = Array.isArray(session.nodes) ? session.nodes : [];
        var newest = -1;
        for (var i = nodes.length - 1; i >= 0; i--) {
          var candidate = nodes[i];
          if (candidate && candidate.kind === "assistant" && Array.isArray(candidate.blocks) && isLive(candidate)) {
            newest = i;
            break;
          }
        }
        nodes.forEach(function (node, position) {
          if (!node || node.kind !== "assistant" || !Array.isArray(node.blocks)) return;
          if (!isLive(node)) return; // history — however late it lands
          node.blocks.forEach(function (block, index) {
            if (!block || block.kind !== "text") return;
            var key = sessionId + ":" + node.turn + ":" + node.step + ":" + index;
            if (position === newest) {
              playSpoken(block.text, key, sessionId, node.turn);
            } else {
              markSpoken(block.text, key); // consume without speaking
            }
          });
        });
      }, [session.sessionId, session.nodes, session.partial]);
    }

    // --- single dictation owner (voice-turn-director step 11, studio project
    // 1919333) ---------------------------------------------------------------
    // Nate has only ONE DSH session open, yet round-2 verdicts showed every
    // utterance judged 2-3x with diverging committed_chars: multiple composer
    // surfaces (e.g. a docked mini-composer alongside the main composer) each
    // mount their own VoiceButton, and each independently arms a real
    // MediaRecorder + createDictationMachine against the same physical mic.
    // Per-instance refs (armingRef/listenGen/etc.) only coordinate a SINGLE
    // instance's re-arms; they cannot see a sibling instance at all. This is
    // a MODULE-scope mutex for sibling composer instances; the cross-tab
    // lease below independently arbitrates page loads on the same origin.
    //
    // Policy: newest claimant wins (matches the existing "swap devices moves
    // the speaker" UX, ownsSpeech()/claimSpeechLease above) — the instance
    // that most recently tried to start listening stops whichever instance
    // held the mic before it, rather than refusing to arm. A stale claim from
    // an instance that never released (e.g. it unmounted without cleanup
    // running) can never wedge the mic permanently: releasing always compares
    // against the CURRENT owner token, so a later claim simply replaces it.
    var dictationOwner = { token: 0, release: null };

    function claimDictationOwnership(release) {
      dictationOwner.token += 1;
      var mine = dictationOwner.token;
      var previousRelease = dictationOwner.release;
      dictationOwner.release = release;
      // Stop whoever held the mic before this instance. Done AFTER recording
      // the new owner so the outgoing instance's own release() (guarded by
      // its token below) is a no-op rather than clobbering the new claim.
      if (previousRelease && previousRelease !== release) {
        try { previousRelease(); } catch (_error) {}
      }
      return mine;
    }

    function releaseDictationOwnership(mine) {
      if (dictationOwner.token !== mine) return; // already superseded; not ours to clear
      dictationOwner.release = null;
    }

    function releaseLeaseForOwner(release) {
      if (dictationOwner.release === release) releaseDictationLease();
    }

    // --- cross-TAB dictation lease (ErrorLog 54851 root cause, voice-turn-
    // director step 11, studio project 1919333) -----------------------------
    // claimDictationOwnership/releaseDictationOwnership above only arbitrate
    // between VoiceButton instances sharing ONE page load (one JS realm).
    // Round-3 (2026-09-25) showed ~5 dictation owners alive at once because
    // Nate had several SAME-ORIGIN Forage tabs open (scratchboards + Hub),
    // each its own page load with its own fresh module state — the in-page
    // mutex cannot see across that boundary at all. Every tab's dictation
    // machine independently armed a real MediaRecorder against the same
    // physical mic and independently judged/committed, which is exactly the
    // "~5 verdict rows per utterance" and "assistant_speaking=false" symptom
    // in ErrorLog 54851: most of those judging tabs were not the one Nate was
    // actually looking at or the one that was speaking.
    //
    // Fix, same shape as claimSpeechLease (output) but for INPUT: a
    // localStorage lease, same-origin only (matches the existing rule that
    // the loopback-vs-tailnet/forage.ink cross-ORIGIN case is a different
    // problem — decision 73507 scopes that to a server-side per-operator
    // lease, now absorbed into the unified-voice "capture once at the ear"
    // plan, insight 74969; this fix only closes the same-origin multi-tab
    // case ErrorLog 54851 actually reproduced). Unlike claimSpeechLease this
    // is NOT keyed by sessionId: there is exactly one physical microphone
    // regardless of which conversation is open, so the lease is global.
    var DICTATION_LEASE_MS = 4000; // short: a crashed/closed tab must free the mic fast
    var DICTATION_LEASE_KEY = "dsh.dictation.lease";

    function claimDictationLease() {
      var mine = myClientId();
      if (!mine) return true; // no identity to arbitrate with: never silence the only surface
      try {
        var now = Date.now();
        var raw = window.localStorage.getItem(DICTATION_LEASE_KEY);
        var held = raw ? JSON.parse(raw) : null;
        if (held && held.client !== mine && (now - held.at) < DICTATION_LEASE_MS) {
          return false; // another tab holds the mic right now
        }
        window.localStorage.setItem(DICTATION_LEASE_KEY, JSON.stringify({ client: mine, at: now }));
        return true;
      } catch (_error) {
        return true; // storage unavailable: never silence the only surface
      }
    }

    // Call periodically WHILE actively listening so a long utterance does not
    // outlive its own lease and hand the mic to a tab that merely polls.
    function renewDictationLease() {
      var mine = myClientId();
      if (!mine) return true;
      try {
        var raw = window.localStorage.getItem(DICTATION_LEASE_KEY);
        var held = raw ? JSON.parse(raw) : null;
        if (held && held.client !== mine) return false; // lost the lease to a newer claimant
        window.localStorage.setItem(DICTATION_LEASE_KEY, JSON.stringify({ client: mine, at: Date.now() }));
        return true;
      } catch (_error) {
        return true;
      }
    }

    function ownsDictationLease(allowUnheld) {
      var mine = myClientId();
      if (!mine) return true;
      try {
        var raw = window.localStorage.getItem(DICTATION_LEASE_KEY);
        var held = raw ? JSON.parse(raw) : null;
        return !held ? !!allowUnheld : held.client === mine && Date.now() - held.at < DICTATION_LEASE_MS;
      } catch (_error) { return true; }
    }

    function dictationIndicatorState(state) {
      return state === "recording" && ownsDictationLease() ? "recording" : "idle";
    }

    function dictationMayStayActive(token, currentToken, wanted, live) {
      return token === currentToken && wanted && live
        && tabIsEligibleToListen() && ownsDictationLease();
    }

    function releaseDictationLease() {
      var mine = myClientId();
      if (!mine) return;
      try {
        var raw = window.localStorage.getItem(DICTATION_LEASE_KEY);
        var held = raw ? JSON.parse(raw) : null;
        if (held && held.client === mine) window.localStorage.removeItem(DICTATION_LEASE_KEY);
      } catch (_error) {}
    }

    // A tab that cannot see or is not the human's focus must never open the
    // mic in the first place — the direct fix for "each is considered active
    // ... only one is active and visible to me" (Nate, ErrorLog 54851 root
    // cause). document.hasFocus() alone is too strict (a click into a DIFFERENT
    // app, e.g. a terminal, would spuriously disarm every tab), so this only
    // gates on tab VISIBILITY. A fresh lease is not stolen by another visible tab.
    function tabIsEligibleToListen() {
      try {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
      } catch (_error) {}
      return true;
    }

    function VoiceButton(props) {
      function shortResumeCue(text) {
        return /^(?:continue|resume|go on|keep going|carry on)[.!?]*$/i.test(String(text || "").trim());
      }
      var stateTuple = React.useState("idle");
      var state = stateTuple[0];
      var setState = stateTuple[1];
      var errorTuple = React.useState("");
      var errorText = errorTuple[0];
      var setErrorText = errorTuple[1];
      var propsRef = React.useRef(props);
      var machineRef = React.useRef(null);
      var liveRef = React.useRef(true);
      var lastShown = React.useRef("");
      var wantListen = React.useRef(!!window.__dshWantListen);
      var mutedRef = React.useRef(!!window.__dshVoiceMuted);
      var bargeSinceRef = React.useRef(0);
      var interruptedRef = React.useRef(null);
      var voiceSubmitInFlightRef = React.useRef(false);
      var pendingFollowupRef = React.useRef([]);
      var pendingLiveRef = React.useRef("");
      var listenGen = React.useRef(0);
      var armingRef = React.useRef(0);
      var startingRef = React.useRef(0);
      var ownerTokenRef = React.useRef(0);
      // Commit order/duplicate guard. The machine gives each segment {segmentId,
      // seq} (seq monotonic per machine); an older machine gives only ids, whose
      // order is the order first seen: {next, last, at: {id: n}, directed: id}.
      var segOrderRef = React.useRef({ next: 1, last: 0, at: {}, directed: "" });
      var lastTracedTranscriptRef = React.useRef("");
      var forceStopRef = React.useRef(null);
      var stableForceStop = React.useRef(function () { forceStopRef.current(true); }).current;
      propsRef.current = props;

      useSpokenPlayback(props.session);

      var disabled = props.session.removed
        || props.session.openState !== "open"
        || props.input.phase === "adjudicating"
        || props.input.phase === "submitting";

      function persistWant(on) {
        wantListen.current = !!on;
        window.__dshWantListen = !!on;
        // Remembered per device, so this surface comes back as it was left.
        saveDeviceState({ listen: !!on });
      }

      function fail(message) {
        setErrorText(message);
        console.warn("[dsh-voice]", message);
        setTimeout(function () { if (liveRef.current) setErrorText(""); }, 6000);
      }

      function pendingDraft() {
        return pendingFollowupRef.current.concat(pendingLiveRef.current || []).filter(Boolean).join("\n\n");
      }

      function clearPending() {
        pendingFollowupRef.current = [];
        pendingLiveRef.current = "";
      }

      function emit(text) {
        lastShown.current = text;
        var phase = propsRef.current.input.phase;
        if (voiceSubmitInFlightRef.current || phase === "submitting" || phase === "adjudicating"
            || pendingFollowupRef.current.length) {
          pendingLiveRef.current = text;
          text = pendingDraft();
        }
        propsRef.current.inputActions.setDraft(text);
      }

      function resetDictation(options) {
        traceVoice("reset", { keepInflight: !!(options && options.keepInflight), committedSeq: options && options.committedSeq });
        lastShown.current = "";
        var machine = machineRef.current;
        if (startingRef.current && !(options && options.keepInflight)) {
          armingRef.current += 1; // reset cancels a pending start; watchdog may re-arm
          startingRef.current = 0;
        }
        if (machine && machine.reset) machine.reset(options);
      }

      function releaseCapture(options) {
        var machine = machineRef.current;
        machineRef.current = options && options.keepInflight ? machine : null;
        if (machine && machine.stop) machine.stop(options);
      }

      function stop(keepInflight) {
        traceVoice("capture_stop", { reason: "user_stop" });
        persistWant(false);
        mutedRef.current = false;
        bargeSinceRef.current = 0;
        interruptedRef.current = null;
        if (!keepInflight) clearPending();
        window.__dshVoiceMuted = false;
        if (!keepInflight) listenGen.current += 1;
        armingRef.current += 1;
        startingRef.current = 0;
        releaseLeaseForOwner(stableForceStop);
        releaseDictationOwnership(ownerTokenRef.current);
        releaseCapture(keepInflight ? { keepInflight: true } : undefined);
        try {
          if (window.__dshSoundPresence) window.__dshSoundPresence.micState("idle");
        } catch (_error) {}
        setState("idle");
      }

      // Called when another VoiceButton instance claims dictation ownership
      // (single-owner mutex above). Must stop the mic and visualizer exactly
      // as a user-initiated stop() does, but must NOT persist "not listening"
      // as this surface's remembered preference — being pre-empted is not the
      // same as this instance being told to stop.
      function forceStop(disarm) {
        traceVoice("capture_stop", { reason: disarm ? "preempted_by_owner" : "lease_denied_or_pending" });
        if (disarm) wantListen.current = false;
        mutedRef.current = false;
        bargeSinceRef.current = 0;
        interruptedRef.current = null;
        clearPending();
        listenGen.current += 1;
        armingRef.current += 1;
        startingRef.current = 0;
        releaseLeaseForOwner(stableForceStop);
        releaseDictationOwnership(ownerTokenRef.current);
        releaseCapture();
        try {
          if (window.__dshSoundPresence) window.__dshSoundPresence.micState("idle");
        } catch (_error) {}
        if (liveRef.current) setState("idle");
      }

      forceStopRef.current = forceStop;

      function directOnce(info, text) {
        var order = segOrderRef.current;
        var id = info && info.segmentId;
        if (id) {
          if (order.directed === id) return; // same final already acted on
          order.directed = id;
        }
        var queue = window.__dshTtsQueue;
        var sessionId = String((propsRef.current.session && propsRef.current.session.sessionId) || "");
        if (shortResumeCue(text) && queue && queue.hasBargeForSession && queue.hasBargeForSession(sessionId)) {
          order.resumed = id || "legacy";
          queue.resume();
          traceVoice("resume_cue", { seg: id, seq: info && info.seq });
          resetDictation({ keepInflight: true, committedSeq: info && info.seq });
          emit("");
          return;
        }
        applyDirector(info && info.director);
      }

      async function armMachine() {
        if (!wantListen.current || mutedRef.current || !liveRef.current || startingRef.current) return false;
        // ErrorLog 54851: a tab the human cannot see must never open the mic,
        // and among same-origin visible tabs only the lease-holder may. Both
        // checks run BEFORE touching the recorder, so a losing/background tab
        // never even requests microphone access.
        if (!tabIsEligibleToListen() || !claimDictationLease()) {
          forceStop(); // a denied lease must never leave a capture alive
          return false;
        }
        var token = armingRef.current += 1;
        startingRef.current = token;
        try {
        releaseCapture();
        var PhoneChat = await loadPhoneChat();
        if (token !== armingRef.current || !wantListen.current || mutedRef.current || !liveRef.current) return false;
        if (!tabIsEligibleToListen() || !ownsDictationLease()) return false; // lost ownership during async load
        ownerTokenRef.current = claimDictationOwnership(stableForceStop);
        listenGen.current += 1;
        var myGen = listenGen.current;
        function acceptsCapturedResult() {
          if (myGen !== listenGen.current || mutedRef.current || !liveRef.current) return false;
          if (wantListen.current) return true;
          // A stopped mic may drain only until another page/tab claims input.
          return dictationOwner.token === ownerTokenRef.current
            && ownsDictationLease(true) && tabIsEligibleToListen()
            && !propsRef.current.session.removed;
        }
        segOrderRef.current = { next: 1, last: 0, at: {}, directed: "", resumed: "" }; // ids/seq are per machine
        lastTracedTranscriptRef.current = "";
        var machine = PhoneChat.createDictationMachine({
          endpoint: voiceBridgeBase() + "/dictate",
          policyEndpoint: voiceBridgeBase() + "/speech-policy",
          refineEndpoint: voiceBridgeBase() + "/refine",
          credentials: "omit",
          // Streaming dictation (step 11): opt in to Forage's NDJSON dictate
          // (machine option `streamDictate`; it sends form fields stream=1 +
          // segment_id): an early `stt` draft, then a `final` verdict that alone
          // gates onCommit. The stt phase arrives via onSegment (director null),
          // the verdict via onVerdict; a machine/server without it answers legacy
          // JSON through onSegment/onCommit unchanged.
          streamDictate: true,
          // Recorder/upload telemetry from the machine ({ev, seg, seq, t, ...}:
          // rec_start/stop/drop+reason, upload_enqueue, fetch_*, stt, final,
          // error). Older machines have no onTrace; this is then inert.
          onTrace: function (event) {
            if (event && event.ev) traceVoice(event.ev, event);
          },
          // Voice Turn Director (studio project 1919333 step 4). Opt-in only
          // from THIS surface (the DSH voice bridge) — decision 72876 / rule
          // asserted by test_only_the_dsh_bridge_opts_in: imagine-chat and
          // the canvas never set this, so tuning here cannot change them.
          // assistantSpeaking/spokenSoFar are read LIVE at upload time
          // (speech-stack.js calls these as functions, never caches), so the
          // director always judges against what is sounding right now, not
          // what was sounding when the mic last armed.
          director: true,
          assistantSpeaking: function () {
            var queue = window.__dshTtsQueue;
            return !!(interruptedRef.current || (queue && queue.isSpeaking && queue.isSpeaking()));
          },
          spokenSoFar: function () {
            var queue = window.__dshTtsQueue;
            if (!queue || !queue.live) return "";
            var interrupted = interruptedRef.current;
            interruptedRef.current = null; // consumed with this upload's assistant_speaking
            if (interrupted) return interrupted.spokenSoFar || "";
            var snapshot = queue.live();
            return (snapshot && snapshot.speaking && snapshot.spokenSoFar) || "";
          },
          // Voice Turn Director step 11 (studio project 1919333): every
          // verdict row must carry a session_id (round-2 sit-down found it
          // null on every row). Read LIVE, same pattern as assistantSpeaking/
          // spokenSoFar above, so a session change between segments (e.g. a
          // new conversation opened in the same composer) is never stale.
          sessionId: function () {
            return String((propsRef.current.session && propsRef.current.session.sessionId) || "");
          },
          onState: function (nextState) {
            if (!liveRef.current || !wantListen.current || mutedRef.current
              || myGen !== listenGen.current || !ownsDictationLease()) return;
            setState(nextState === "listening" ? "recording" : "idle");
            try {
              if (window.__dshSoundPresence) {
                window.__dshSoundPresence.micState(nextState === "off" ? "idle" : "listening");
              }
            } catch (_error) {}
          },
          onTranscript: function (view) {
            // Explicit mic-off still drains audio captured before the stop.
            if (!acceptsCapturedResult()) return;
            var draft = String(view && view.transcript || "");
            var capturing = !!(view && view.capturing);
            var traced = draft + "\u0000" + capturing;
            if (traced !== lastTracedTranscriptRef.current) {
              // capture edges = the only recorder signal the machine exposes today
              lastTracedTranscriptRef.current = traced;
              traceVoice("transcript", { seg: view && view.segmentId, seq: view && view.seq, chars: draft.length, capturing: capturing, draft: !!(view && view.draft) });
            }
            emit(draft);
          },
          // Voice Turn Director (studio project 1919333 step 4): the three
          // post-interrupt behaviors (decision 72878), driven by the
          // director verdict the route already computed. turn_complete /
          // backchannel / noise need no TTS action here — turn_complete
          // presses send via onCommit below exactly as before; the others
          // never commit (voice_director.commits), so onCommit is simply not
          // called for them, and this is the only hook that sees them.
          onSegment: function (_text, info) {
            if (!acceptsCapturedResult()) return false;
            var order = segOrderRef.current;
            var id = info && info.segmentId;
            if (id && !(id in order.at)) order.at[id] = order.next++; // first-seen order (id-only machines)
            var early = !!(info && info.phase === "stt"); // first streaming artifact called onSegment at stt
            traceVoice(early ? "draft" : "segment", {
              seg: id, seq: info && info.seq, chars: String(_text || "").length, commit: !!(info && info.commit),
              choice: info && info.director && info.director.choice || null,
              commitSource: info && info.commitSource || null
            });
            if (!early) directOnce(info, _text);
            return true;
          },
          // Streaming final (NDJSON path only): the verdict + server timing. The
          // current machine calls onSegment (with the director) AND onVerdict for
          // one final; an earlier one called only onVerdict. directOnce() makes
          // the TTS action fire exactly once either way.
          onVerdict: function (info) {
            if (!acceptsCapturedResult()) return;
            traceVoice("verdict", {
              seg: info && info.segmentId, seq: info && info.seq, commit: !!(info && info.commit),
              choice: info && info.director && info.director.choice || null,
              commitSource: info && info.commitSource || null,
              timing: info && info.timing || null
            });
            directOnce(info, info && info.text);
          },
          onCommit: async function (transcript, info) {
            var seg = info && info.segmentId;
            var seq = info && info.seq;
            try {
              if (window.__dshSoundPresence) window.__dshSoundPresence.sttAccepted();
            } catch (_error) {}
            if (!acceptsCapturedResult()) {
              traceVoice("commit_drop", { seg: seg, seq: seq, reason: "stale_generation_or_owner" });
              return;
            }
            var queue = window.__dshTtsQueue;
            var sessionId = String((propsRef.current.session && propsRef.current.session.sessionId) || "");
            if (segOrderRef.current.resumed !== (seg || "legacy") && shortResumeCue(transcript)
              && queue && queue.hasBargeForSession && queue.hasBargeForSession(sessionId)) {
              segOrderRef.current.resumed = seg || "legacy";
              queue.resume();
              resetDictation({ keepInflight: true, committedSeq: seq });
              emit("");
            }
            if (segOrderRef.current.resumed === (seg || "legacy")) {
              traceVoice("commit_drop", { seg: seg, seq: seq, reason: "resume_cue" });
              if (!seg) segOrderRef.current.resumed = "";
              return;
            }
            // Streaming: the machine orders finals, but never let an older
            // segment's late verdict (or a repeat) submit after a newer one
            // already did (transcripts are cumulative: no text is lost).
            var order = segOrderRef.current;
            var index = typeof seq === "number" ? seq : (seg && order.at[seg]);
            if (index) {
              if (index <= order.last) {
                traceVoice("commit_drop", { seg: seg, seq: seq, reason: "out_of_order", last: order.last });
                return;
              }
              order.last = index;
              // keep the id map bounded (a repeat of a just-committed id must still be caught)
              for (var known in order.at) if (order.at[known] < index - 32) delete order.at[known];
            }
            var output = String(transcript || lastShown.current).trim();
            var current = propsRef.current;
            var busy = voiceSubmitInFlightRef.current
              || current.input.phase === "adjudicating" || current.input.phase === "submitting";
            if (busy && output) {
              // Each reset starts a fresh transcript; keep *all* later committed
              // turns, not just the last one seen while the host is submitting.
              pendingFollowupRef.current.push(output);
              pendingLiveRef.current = "";
            } else if (!busy && output) {
              pendingLiveRef.current = output;
              output = pendingDraft();
              clearPending();
            }
            traceVoice("commit", { seg: seg, seq: seq, chars: output.length, busy: !!busy, source: info && info.commitSource || null });
            // committedSeq: a streaming machine drops only the committed prefix
            // and keeps later segments' early drafts (legacy: ignored/undefined).
            resetDictation({ keepInflight: true, committedSeq: seq });
            if (!output || current.session.removed) return;
            if (busy) {
              current.inputActions.setDraft(pendingDraft());
              return;
            }
            // The public input action face is synchronous: setDraft publishes to
            // the machine before submit reads it. Submit in the same turn so a
            // rendered-props race cannot leave the spoken draft stranded.
            traceVoice("submit", { seg: seg, seq: seq, chars: output.length });
            current.inputActions.setDraft(output);
            voiceSubmitInFlightRef.current = true; // close the pre-render double-submit window
            current.inputActions.submit();
          },
          onLevel: function (rms) {
            try {
              if (window.__dshSoundPresence) window.__dshSoundPresence.micLevel(rms);
            } catch (_error) {}
            if (myGen !== listenGen.current || !wantListen.current || mutedRef.current) return;
            var queue = window.__dshTtsQueue;
            var live = queue && queue.live && queue.live();
            if (!live || !live.speaking || rms < 0.025) { bargeSinceRef.current = 0; return; }
            var now = Date.now();
            if (!bargeSinceRef.current) { bargeSinceRef.current = now; return; }
            if (now - bargeSinceRef.current < 80) return;
            // ponytail: RMS on the AEC stream is the fast local gate; tune 0.025
            // after a measured false-interrupt or missed-interrupt browser retest.
            interruptedRef.current = { spokenSoFar: live.spokenSoFar };
            bargeSinceRef.current = 0;
            queue.cancel("barge_in");
          },
          onError: fail
        });
        if (token !== armingRef.current || !wantListen.current || mutedRef.current || !liveRef.current || !ownsDictationLease()) return false;
        machineRef.current = machine;
        var started = await machine.start();
        if (!started) {
          if (token !== armingRef.current || !wantListen.current || mutedRef.current || !liveRef.current) return false;
          throw new Error("canonical speech stack did not start");
        }
        if (!dictationMayStayActive(token, armingRef.current, wantListen.current, liveRef.current)) {
          machine.stop();
          return false;
        }
        return true;
        } finally {
          if (startingRef.current === token) startingRef.current = 0;
        }
      }

      async function start() {
        setErrorText("");
        setState("idle");
        persistWant(true);
        mutedRef.current = !!window.__dshVoiceMuted;
        unlockAudio();
        if (mutedRef.current) {
          setState("idle");
          return;
        }
        try {
          if (await armMachine() && liveRef.current && wantListen.current) setState("recording");
        } catch (error) {
          persistWant(false);
          fail("mic unavailable: " + (error && error.message ? error.message : String(error)));
          setState("idle");
        }
      }

      // Any host submission is also a dictation-generation boundary. The
      // spoken-commit path resets synchronously above; this covers the ordinary
      // Send button so queued uploads cannot restore the just-sent transcript.
      React.useLayoutEffect(function () {
        var phase = props.input.phase;
        if (phase === "adjudicating" || phase === "submitting") {
          // A spoken submit already cleared only the committed transcript.
          // Do not kill a newer recorded/queued follow-up while it is sent.
          if (!voiceSubmitInFlightRef.current) {
            clearPending();
            resetDictation();
          } else if (pendingDraft()) {
            propsRef.current.inputActions.setDraft(pendingDraft());
          }
          // The prompt itself carries this surface's clientId, so the host
          // publishes ownership; nothing to claim locally.
        } else {
          voiceSubmitInFlightRef.current = false;
          if (pendingDraft()) propsRef.current.inputActions.setDraft(pendingDraft());
        }
      }, [props.input.phase]);

      // Hand the microphone over when the human moves to another device: a
      // hot mic left behind would keep capturing a room nobody is in.
      React.useEffect(function () {
        var sessionId = String(props.session.sessionId || "");
        bargeSinceRef.current = 0;
        interruptedRef.current = null;
        clearPending();
        var queue = window.__dshTtsQueue;
        if (queue && queue.forgetBargeForSession) queue.forgetBargeForSession(sessionId);
        function checkOwnership() {
          if (wantListen.current && !ownsSpeech(sessionId)) stop();
        }
        var timer = setInterval(checkOwnership, 3000);
        return function () { clearInterval(timer); };
      }, [props.session.sessionId]);

      React.useEffect(function () {
        window.__dshOnVoiceMute = function (on) {
          if (!liveRef.current) return;
          if (on) {
            if (mutedRef.current) return;
            mutedRef.current = true;
            bargeSinceRef.current = 0;
            interruptedRef.current = null;
            listenGen.current += 1;
            if (startingRef.current) {
              armingRef.current += 1;
              startingRef.current = 0;
            }
            releaseCapture();
            if (wantListen.current) setState("idle");
            return;
          }
          if (!mutedRef.current) return;
          mutedRef.current = false;
          if (wantListen.current) {
            armMachine().catch(function (error) {
              fail("mic resume: " + (error && error.message ? error.message : String(error)));
            });
          }
        };
        return function () {
          if (window.__dshOnVoiceMute) window.__dshOnVoiceMute = null;
        };
      }, []);

      React.useEffect(function () {
        if (wantListen.current && !mutedRef.current) start();
      }, []);

      React.useEffect(function () {
        var id = setInterval(function () {
          if (!liveRef.current || !wantListen.current || mutedRef.current) return;
          if (startingRef.current) {
            if (!renewDictationLease()) forceStop();
            return;
          }
          var machine = machineRef.current;
          if (machine && machine.isActive && machine.isActive()) {
            // Actively listening: keep the cross-tab lease alive (short TTL,
            // must be renewed well inside DICTATION_LEASE_MS) so a long
            // utterance is never handed to another tab mid-sentence. If the
            // lease was lost after expiry or release, stop immediately.
            if (!renewDictationLease()) forceStop();
            return;
          }
          armMachine().catch(function (error) {
            fail("mic watchdog: " + (error && error.message ? error.message : String(error)));
          });
        }, 1200);
        return function () { clearInterval(id); };
      }, []);

      // ErrorLog 54851 root cause (Nate, 2026-09-25): "each is considered
      // active — only one is active and visible to me ... they are all forage
      // pages". A tab going to the background must drop the mic and the lease
      // immediately rather than waiting for the 1.2s watchdog to notice it is
      // still "active" (isActive() does not know about page visibility), and
      // must re-claim on return rather than staying silently off forever.
      React.useEffect(function () {
        function onVisibility() {
          if (!liveRef.current) return;
          if (document.visibilityState === "hidden") {
            if (wantListen.current && !mutedRef.current) forceStop();
            return;
          }
          if (wantListen.current && !mutedRef.current) {
            var machine = machineRef.current;
            if (!machine || !machine.isActive || !machine.isActive()) {
              armMachine().catch(function (error) {
                fail("mic resume: " + (error && error.message ? error.message : String(error)));
              });
            }
          }
        }
        try { document.addEventListener("visibilitychange", onVisibility); } catch (_error) {}
        return function () {
          try { document.removeEventListener("visibilitychange", onVisibility); } catch (_error) {}
        };
      }, []);

      React.useEffect(function () {
        function onLeaseChange(event) {
          if ((event.key === DICTATION_LEASE_KEY || event.key === null) && wantListen.current && !ownsDictationLease()) forceStop();
        }
        window.addEventListener("storage", onLeaseChange);
        return function () { window.removeEventListener("storage", onLeaseChange); };
      }, []);

      React.useEffect(function () {
        return function () {
          liveRef.current = false;
          armingRef.current += 1;
          startingRef.current = 0;
          bargeSinceRef.current = 0;
          interruptedRef.current = null;
          clearPending();
          var queue = window.__dshTtsQueue;
          if (queue && queue.forgetBargeForSession) queue.forgetBargeForSession(null);
          releaseLeaseForOwner(stableForceStop);
          releaseDictationOwnership(ownerTokenRef.current);
          releaseCapture();
        };
      }, []);

      var indicatorState = dictationIndicatorState(state);
      var label = indicatorState === "recording"
        ? "Listening… say “send it” · tap to stop"
        : errorText || "Voice input · tap to talk";
      return React.createElement(
        "button",
        {
          type: "button",
          className: "dsh-voice-button dsh-voice-mic",
          "data-state": indicatorState,
          "data-error": errorText ? "true" : "false",
          "data-dsh-voice-version": VERSION,
          "aria-label": label,
          title: label,
          disabled: disabled,
          onMouseDown: function (event) { event.preventDefault(); },
          onClick: function () { if (indicatorState === "recording") stop(true); else start(); }
        },
        indicatorState === "recording" ? React.createElement("span", { className: "dsh-voice-pulse", "aria-hidden": true }) : null,
        micGlyph()
      );
    }

    var inject = ["slots"];

    function apply(ctx) {
      ensureStyle();
      installVoiceGlobals();
      ctx.slots.inject("conversation.input.left", function () {
        return ctx.slots.register({
          name: "conversation.input.left",
          id: "dsh-voice",
          order: 30
        }, VoiceButton);
      });
      ctx.slots.inject("conversation.input.left", function () {
        return ctx.slots.register({
          name: "conversation.input.left",
          id: "dsh-voice-speaker",
          order: 31
        }, SpeakerButton);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.spokenParts = spokenParts; // test seam (test_spoken_mention.mjs)
    return module.exports;
  }
});
