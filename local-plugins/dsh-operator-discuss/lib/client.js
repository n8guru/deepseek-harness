// Browser half: URL intake -> configured, visible DSH session -> first turn.
window.__ModuleLoader__.load({
  id: 'dsh-operator-discuss',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports
    const name = 'operator-discuss'
    const inject = ['sessions', 'connection']

    function positiveInteger(raw) {
      const value = Number(raw)
      return Number.isSafeInteger(value) && value > 0 ? value : null
    }

    function returnUrl() {
      if (!location.hash.startsWith('#return=')) return null
      try {
        const value = decodeURIComponent(location.hash.slice('#return='.length))
        const parsed = new URL(value)
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
      } catch {
        return null
      }
    }

    function notice(text, kind, returnTo) {
      let box = document.getElementById('dsh-operator-discuss-notice')
      if (!box) {
        box = document.createElement('aside')
        box.id = 'dsh-operator-discuss-notice'
        Object.assign(box.style, {
          position: 'fixed', zIndex: '2147483000', left: '50%', top: '18px',
          transform: 'translateX(-50%)', maxWidth: 'min(720px,calc(100vw - 28px))',
          padding: '11px 14px', borderRadius: '12px', font: '600 13px/1.4 system-ui,sans-serif',
          color: '#eef2f7', background: '#20242c', border: '1px solid #4b5565',
          boxShadow: '0 12px 36px rgba(0,0,0,.35)',
        })
        document.body.appendChild(box)
      }
      box.replaceChildren(document.createTextNode(text))
      box.style.borderColor = kind === 'error' ? '#d66b73' : '#5f83ad'
      if (returnTo) {
        const link = document.createElement('a')
        link.href = returnTo
        link.textContent = 'Return to card'
        Object.assign(link.style, { marginLeft: '12px', color: '#8ec7ff' })
        box.appendChild(link)
      }
      return box
    }

    async function waitUntilKnown(sessions, sessionId, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (sessions.list.getSnapshot().byId[sessionId]) return true
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return false
    }

    async function selectPreferredModel(ctx, sessionId, preferred) {
      try {
        const directory = await ctx.connection.api.sessions.models({ sessionId })
        if (!directory.result.ok) return false
        const groups = directory.result.value.groups || []
        const provider = groups.find(group => group.id === preferred.provider)
          || groups.find(group => /openai|codex/i.test(group.id))
        if (!provider) return false
        const model = provider.models.find(row => row.id === preferred.model)
          || provider.models.find(row => /gpt-5\.6-sol/i.test(row.id))
        if (!model) return false
        const selected = await ctx.connection.api.sessions.selectModel({
          sessionId,
          provider: provider.id,
          model: model.id,
          reasoningEffort: preferred.reasoningEffort,
        })
        return selected.result.ok
      } catch {
        return false
      }
    }

    function replaceWithSession(sessionId) {
      const url = new URL(location.href)
      url.searchParams.delete('operator_decision_id')
      url.searchParams.set('operator_session', sessionId)
      history.replaceState(null, '', url.pathname + url.search + url.hash)
    }

    async function openExisting(ctx, sessionId, returnTo) {
      if (!(await waitUntilKnown(ctx.sessions, sessionId, 10_000))) {
        notice(`DSH session ${sessionId} is not available on this host.`, 'error', returnTo)
        return
      }
      ctx.sessions.open(sessionId)
    }

    async function launch(ctx, decisionId, returnTo) {
      const progress = notice(`Opening operator card #${decisionId} in a full-access DSH session…`, 'info', returnTo)
      const response = await fetch(`/api/operator-discuss-card?decision_id=${encodeURIComponent(decisionId)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      })
      const raw = await response.text()
      let intake
      try { intake = JSON.parse(raw) } catch { throw new Error(`DSH card intake returned non-JSON (HTTP ${response.status})`) }
      if (!response.ok || !intake.ok) throw new Error(intake.error || `card intake failed (HTTP ${response.status})`)

      const sessionId = await ctx.sessions.create({ cwd: intake.cwd })
      const binding = ctx.sessions.binding(sessionId)
      if (!binding) throw new Error('new DSH session is not locally addressable')
      const session = binding.session

      ctx.sessions.open(sessionId)
      replaceWithSession(sessionId)

      const permission = await session.command('/permission danger-full-access')
      if (!permission.ok || !permission.value.matched) {
        throw new Error('DSH could not enable the danger-full-access permission preset')
      }

      await selectPreferredModel(ctx, sessionId, intake.preferredModel)
      await session.rename(`Discuss · ${intake.title}`)

      const sent = await session.prompt([{ type: 'text', text: intake.prompt }], 'queue')
      if (!sent.ok) throw new Error(`DSH rejected the card prompt: ${sent.error.code}: ${sent.error.message}`)

      notice(`Operator card #${decisionId} is open in a full-access DSH session.`, 'info', returnTo)
      window.setTimeout(() => { if (progress.isConnected) progress.remove() }, 4500)
    }

    function apply(ctx) {
      if (window.__dshOperatorDiscussLaunching) return
      const query = new URLSearchParams(location.search)
      const decisionId = positiveInteger(query.get('operator_decision_id'))
      const sessionId = query.get('operator_session')
      if (decisionId === null && !sessionId) return

      window.__dshOperatorDiscussLaunching = true
      const returnTo = returnUrl()
      const task = decisionId !== null
        ? launch(ctx, decisionId, returnTo)
        : openExisting(ctx, sessionId, returnTo)
      void task.catch(error => {
        notice(`Could not open operator discussion: ${String(error?.message || error)}`, 'error', returnTo)
        window.__dshOperatorDiscussLaunching = false
      })
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
