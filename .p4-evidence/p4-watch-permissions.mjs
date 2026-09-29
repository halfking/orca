#!/usr/bin/env node
// Answer opencode's permission prompts in two supervised workers.
//
// Why this exists: an Orca supervised worker has nobody at the keyboard, and opencode asks before
// every new command shape. Each answer is "Allow always", which opencode scopes to this OpenCode
// process ("until OpenCode is restarted") rather than to the user's global config.
//
// The loop is bounded and reports what it answered. It never presses Enter on a screen that is not
// a permission prompt, because Enter in an agent TUI means something else entirely.

import { execFileSync } from 'node:child_process'

const TERMINALS = process.argv.slice(2)
const DEADLINE_MS = Number(process.env.P4_WATCH_MS ?? 900_000)
const started = Date.now()

function orca(args) {
  return execFileSync('orca', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
}

function tail(handle) {
  const raw = JSON.parse(orca(['terminal', 'read', '--terminal', handle, '--limit', '14', '--json']))
  return (raw.result?.terminal?.tail ?? []).join('\n')
}

function send(handle, text, enter) {
  const args = ['terminal', 'send', '--terminal', handle, '--json']
  if (text) {
    args.push('--text', text)
  }
  if (enter) {
    args.push('--enter')
  }
  orca(args)
}

const answered = new Map()
let lastLog = 0
while (Date.now() - started < DEADLINE_MS) {
  for (const handle of TERMINALS) {
    let screen
    try {
      screen = tail(handle)
    } catch {
      continue
    }
    // Two distinct screens, answered in order: the picker, then its confirmation.
    if (/Allow once\s+Allow always\s+Reject/.test(screen)) {
      send(handle, '[C', false)
      send(handle, '', true)
      answered.set(handle, (answered.get(handle) ?? 0) + 1)
      if (Date.now() - lastLog > 15_000) {
        process.stdout.write(
          `${new Date().toISOString()} ${handle.slice(0, 12)}: allowed always (${answered.get(handle)} so far)\n`
        )
        lastLog = Date.now()
      }
    } else if (/△ Always allow[\s\S]*Confirm\s+Cancel/.test(screen)) {
      send(handle, '', true)
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 4000))
}
process.stdout.write(
  `watched ${TERMINALS.length} terminals for ${Math.round((Date.now() - started) / 1000)}s: ` +
    `${[...answered.entries()].map(([h, n]) => `${h.slice(0, 12)}=${n}`).join(' ') || 'no prompts answered'}\n`
)
