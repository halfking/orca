import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { recordSessionScanIssue } from './session-scan-issues'
import { SessionNewestFiles } from './session-newest-files'
import { errorMessage } from './session-scanner-values'
import type {
  AiVaultScanOptions,
  FileWithMtime,
  SessionFileDiscovery
} from './session-scanner-types'

const ZCODE_AGENTS_DIR = join(homedir(), '.zcode', 'cli', 'agents')

/**
 * Discover ZCode session candidates.
 *
 * Why custom: ZCode's on-disk layout is `<root>/sess_<UUID>/agent_<UUID>/{metadata.json,output.txt}`,
 * and one session can spawn many agents (sub-tasks). Naively walking for every
 * metadata.json would surface one row per subagent. Picking exactly one
 * metadata.json per `sess_<UUID>` — preferring the one whose output transcript
 * is newest — keeps the row count equal to the user's actual session count.
 */
export function zcodeDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  const rootDirs = uniqueZcodeAgentsRoots([
    options.zcodeAgentsDir ?? ZCODE_AGENTS_DIR,
    ...wslHomeDirs.map((homeDir) => join(homeDir, '.zcode', 'cli', 'agents'))
  ])
  return rootDirs.map((rootDir) => discoverZcodeSessions(rootDir, limit, issues))
}

function uniqueZcodeAgentsRoots(rootDirs: readonly string[]): string[] {
  return Array.from(new Set(rootDirs.map((root) => root.replace(/[\\/]+$/, ''))))
}

async function discoverZcodeSessions(
  rootDir: string,
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery> {
  const files = new SessionNewestFiles(limit)
  let sessionDirs
  try {
    sessionDirs = await wslGatedReaddir(rootDir, 'scan')
  } catch (err) {
    // Why: the root is opt-in for every host. A missing opt-in root (ENOENT)
    // is the same "this agent is not installed here" signal other agents return
    // when their config dir does not exist — record it as "no sessions" and
    // stay silent so isolated-fixture scans don't leak spurious issues.
    if (isMissingRootError(err)) {
      return { agent: 'zcode', rootDir, files: [] }
    }
    recordSessionScanIssue(issues, {
      agent: 'zcode',
      path: rootDir,
      message: errorMessage(err)
    })
    return { agent: 'zcode', rootDir, files: [] }
  }
  for (const entry of sessionDirs) {
    if (!entry.isDirectory()) {
      continue
    }
    if (!entry.name.startsWith('sess_')) {
      continue
    }
    const sessionDir = join(rootDir, entry.name)
    const candidate = await pickNewestMetadataForSession(sessionDir)
    if (!candidate) {
      continue
    }
    files.add(candidate)
  }
  return { agent: 'zcode', rootDir, files: files.newest() }
}

function isMissingRootError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code
    return code === 'ENOENT' || code === 'ENOTDIR'
  }
  return false
}

// Why: each `sess_<UUID>` may have many `agent_<UUID>/` children (sub-tasks).
// Pick the agent whose sibling `output.txt` has the largest mtime; that is the
// agent that most recently produced content and therefore best represents the
// session's overall activity.
async function pickNewestMetadataForSession(
  sessionDir: string
): Promise<FileWithMtime | null> {
  let best: { metadata: FileWithMtime; outputMtime: number } | null = null
  let agentDirs: Awaited<ReturnType<typeof wslGatedReaddir>>
  try {
    agentDirs = await wslGatedReaddir(sessionDir, 'scan')
  } catch {
    return null
  }
  for (const entry of agentDirs) {
    if (!entry.isDirectory() || !entry.name.startsWith('agent_')) {
      continue
    }
    const metadataPath = join(sessionDir, entry.name, 'metadata.json')
    const outputPath = join(sessionDir, entry.name, 'output.txt')
    let metadataStat
    try {
      metadataStat = await wslGatedStat(metadataPath, 'scan')
    } catch {
      continue
    }
    let outputMtime = 0
    try {
      const outputStat = await wslGatedStat(outputPath, 'scan')
      outputMtime = outputStat.mtimeMs
    } catch {
      // output.txt may not exist for sessions that failed before producing one;
      // fall back to the metadata mtime so the row still surfaces.
      outputMtime = metadataStat.mtimeMs
    }
    if (!best || outputMtime > best.outputMtime) {
      best = {
        metadata: {
          path: metadataPath,
          mtimeMs: metadataStat.mtimeMs,
          modifiedAt: new Date(metadataStat.mtimeMs).toISOString(),
          sizeBytes: metadataStat.size,
          dev: metadataStat.dev,
          ino: metadataStat.ino,
          nlink: metadataStat.nlink
        },
        outputMtime
      }
    }
  }
  return best?.metadata ?? null
}

// Why: the parser resolves sessionId from `dirname(dirname(metadataPath))`'s
// basename. Exported so tests and sibling readers can use the same derivation
// without re-implementing it.
export function zcodeSessionIdFromMetadataPath(metadataPath: string): string {
  // <root>/sess_<UUID>/agent_<UUID>/metadata.json -> sess_<UUID>
  const parts = metadataPath.split(/[\\/]/)
  const sessionDir = parts.at(-3) ?? ''
  return basename(sessionDir)
}

void zcodeSessionIdFromMetadataPath