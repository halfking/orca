import { basename, dirname } from 'node:path'
import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { FileWithMtime, SessionAccumulator } from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import { asRecord, extractString, numberValue } from './session-scanner-values'

/**
 * Parse one ZCode session. ZCode stores each Task invocation as
 * `<agents-root>/sess_<sessionId>/agent_<taskId>/metadata.json` plus a sibling
 * `output.txt` carrying the transcript. The scanner surfaces one candidate per
 * `metadata.json`, but the sessionId Orca records is always the outer
 * `sess_<UUID>` so a session with N subagents collapses to a single row.
 */
export async function parseZCodeSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform = process.platform,
  messages?: TranscriptMessageSink
): Promise<AiVaultSession | null> {
  let raw: string
  try {
    raw = await wslGatedReadFile(file.path, 'utf-8', 'scan')
  } catch {
    return null
  }
  const record = asRecord(JSON.parse(raw) as unknown)
  if (!record) {
    return null
  }

  const accumulator = createAccumulator({
    agent: 'zcode',
    file,
    sessionId: zcodeSessionIdFor(file.path, record),
    messages
  })
  accumulator.cwd = extractString(record.workspaceRoot) ?? extractString(record.cwd)
  accumulator.title = zcodeTitleFromPrompt(extractString(record.prompt))
  accumulator.model = zcodeModelFromRecord(record)
  updateTimeline(accumulator, extractString(record.createdAt))
  updateTimeline(accumulator, extractString(record.updatedAt))
  updateTimeline(accumulator, extractString(record.completedAt))

  const usage = asRecord(record.usage)
  const totalTokens = numberValue(record.totalTokens) ?? numberValue(usage?.totalTokens)
  if (totalTokens !== null) {
    accumulator.totalTokens = totalTokens
  }
  const toolUseCount = numberValue(record.totalToolUseCount)
  if (toolUseCount !== null && toolUseCount > 0) {
    accumulator.messageCount = toolUseCount + 1
  }

  const sibling = zcodeSiblingOutputPath(file.path)
  if (sibling) {
    let output: string
    try {
      output = await wslGatedReadFile(sibling, 'utf-8', 'scan')
    } catch {
      output = ''
    }
    if (output) {
      consumeZCodeOutput(accumulator, output)
    }
  }

  return finalizeSession(accumulator, platform)
}

// Why: the metadata file lives at <root>/sess_<UUID>/agent_<UUID>/metadata.json,
// and the session id Orca records is the *outer* session — subagent metadata
// files share one sess_<UUID>, so collapsing to that id deduplicates by session.
function zcodeSessionIdFor(metadataPath: string, record: Record<string, unknown>): string {
  const explicit = extractString(record.parentSessionId)
  if (explicit) {
    return explicit
  }
  const parent = dirname(dirname(metadataPath))
  return basename(parent)
}

function zcodeSiblingOutputPath(metadataPath: string): string | null {
  const dir = dirname(metadataPath)
  return `${dir}/output.txt`
}

function zcodeTitleFromPrompt(prompt: string | null): string | null {
  if (!prompt) {
    return null
  }
  const firstLine = prompt.split('\n', 1)[0]?.trim() ?? ''
  if (!firstLine) {
    return null
  }
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine
}

function zcodeModelFromRecord(record: Record<string, unknown>): string | null {
  const direct = extractString(record.model)
  if (direct) {
    return direct
  }
  const profile = asRecord(record.profileSnapshot)
  return extractString(profile?.name)
}

// Why: ZCode's `output.txt` is a flat, unsectioned transcript that may interleave
// assistant prose with tool blocks. We can't safely parse it line-by-line, but we
// can use the user prompt the metadata already carries plus the first/last chunk
// of the output as the preview. A non-empty output guarantees a non-zero
// messageCount and an `assistant` preview turn so the session is resumable.
function consumeZCodeOutput(accumulator: SessionAccumulator, output: string): void {
  const trimmed = output.trim()
  if (!trimmed) {
    return
  }
  if (accumulator.messageCount === 0) {
    accumulator.messageCount = 2
  }
  addPreviewContent(accumulator, 'assistant', trimmed.slice(0, 4096))
}

// Exported for unit tests.
export const __zcodeInternals = {
  zcodeSessionIdFor,
  zcodeSiblingOutputPath,
  zcodeTitleFromPrompt,
  zcodeModelFromRecord,
  consumeZCodeOutput
}