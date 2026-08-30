/**
 * Web application entry: thin bootstrap over the shell library. Everything —
 * module-table seeding, the boot page, and the UI-renderer handoff — lives
 * in @deepseek-ai/dsh-client-web; this file only finds the mount point.
 */
import { Context } from '@deepseek-ai/cordis'
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import { configureEmbedSurface, initializeEmbedSession } from './embed.ts'

// `/embed` consumes the same host-injected graph as `/`, projected before the
// shell creates its module system. The normal route is deliberately untouched.
const embedContext = configureEmbedSurface(window)

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')
void new AppWebEntry(el, undefined, async (ctx: Context) => initializeEmbedSession(ctx, embedContext)).run()
