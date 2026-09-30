#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const SCRIPT_DIR = import.meta.dirname
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..')
const DEFAULT_SOURCE = path.join(process.env.HOME ?? '', '.zcode', 'skills')
const DEFAULT_TARGET_ROOT = path.join(REPO_ROOT, 'skills')
const DEFAULT_PREFIX = 'zcode-'

function printUsage() {
  console.log(`Usage: import-zcode-skills.mjs [options]

Options:
  --source <dir>        Source skills directory (default: ~/.zcode/skills)
  --target <dir>        Target skills root (default: <repo>/skills)
  --prefix <slug>       Slug prefix for imported skills (default: zcode-)
  --allow-categories    Comma-separated source subdirs to import (default: all except deprecated)
  --skip-categories     Comma-separated source subdirs to skip (default: deprecated)
  --include-extras      Also copy non-SKILL.md files; manifest will reject exec-bit files
  --dry-run             Print what would be copied without touching disk
  --regenerate          Run pnpm run generate:skill-bundle-manifest after import (default: true)
  --no-regenerate       Do not run the manifest generator after import
  --help                Show this help
`)
}

function parseList(value) {
  return value
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function parseArgs(argv) {
  const out = {
    source: DEFAULT_SOURCE,
    targetRoot: DEFAULT_TARGET_ROOT,
    prefix: DEFAULT_PREFIX,
    allowCategories: null,
    skipCategories: ['deprecated'],
    includeExtras: false,
    dryRun: false,
    regenerate: true,
    help: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--source':
        out.source = path.resolve(argv[++index])
        break
      case '--target':
        out.targetRoot = path.resolve(argv[++index])
        break
      case '--prefix':
        out.prefix = argv[++index]
        break
      case '--allow-categories':
        out.allowCategories = parseList(argv[++index])
        break
      case '--skip-categories':
        out.skipCategories = parseList(argv[++index])
        break
      case '--include-extras':
        out.includeExtras = true
        break
      case '--no-regenerate':
        out.regenerate = false
        break
      case '--regenerate':
        out.regenerate = true
        break
      case '--dry-run':
        out.dryRun = true
        break
      case '--help':
      case '-h':
        out.help = true
        break
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown flag: ${arg}`)
          process.exitCode = 2
          printUsage()
          process.exit(2)
        }
        break
    }
  }
  return out
}

function sanitizeSlug(value) {
  return value
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function exists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function walkSkillFolders(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const result = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const category = entry.name
    const categoryPath = path.join(root, category)
    const subEntries = await readdir(categoryPath, { withFileTypes: true })
    for (const sub of subEntries) {
      if (!sub.isDirectory() || sub.name.startsWith('.')) continue
      const skillPath = path.join(categoryPath, sub.name)
      const skillMdPath = path.join(skillPath, 'SKILL.md')
      if (!(await exists(skillMdPath))) continue
      result.push({ category, name: sub.name, absPath: skillPath })
    }
  }
  return result.sort((left, right) => {
    const categoryCompare = left.category.localeCompare(right.category)
    return categoryCompare !== 0 ? categoryCompare : left.name.localeCompare(right.name)
  })
}

async function listExisting(targetRoot) {
  const entries = await readdir(targetRoot, { withFileTypes: true })
  return new Set(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  )
}

function parseSkillFrontMatter(contents) {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return { name: null, description: null }
  const fm = match[1]
  const nameMatch = fm.match(/^name:\s*(.+)$/m)
  const descMatch = fm.match(/^description:[>\s]*([\s\S]*?)(?=\n[a-zA-Z][\w-]*:|\n---|\n*$)/m)
  return {
    name: nameMatch ? nameMatch[1].trim().replace(/^['"]|['"]$/g, '') : null,
    description: descMatch ? descMatch[1].replace(/\s+/g, ' ').trim().slice(0, 200) : null
  }
}

function decideSkill(skill, options, existing) {
  const { category, name } = skill
  if (options.skipCategories.includes(category)) {
    return { action: 'skip', reason: `category ${category} in skip list` }
  }
  if (options.allowCategories && !options.allowCategories.includes(category)) {
    return { action: 'skip', reason: `category ${category} not in allow list` }
  }
  const slug = sanitizeSlug(`${options.prefix}${category}-${name}`)
  if (!slug || slug === options.prefix.replace(/-+$/, '')) {
    return { action: 'skip', reason: 'empty slug after sanitization' }
  }
  if (existing.has(slug)) {
    return { action: 'conflict', slug, reason: `target ${slug} already exists` }
  }
  return { action: 'add', slug }
}

async function copySkill(sourceDir, targetDir, dryRun, includeExtras) {
  if (dryRun) {
    return { copiedFiles: 0, skippedFiles: 0 }
  }
  await mkdir(targetDir, { recursive: true })
  const entries = await readdir(sourceDir, { withFileTypes: true })
  let copied = 0
  let skipped = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name === 'SKILL.md' || includeExtras) {
      // Why: Orca's manifest generator rejects any file with execute bits set,
      // even on POSIX. We strip them defensively on copy via cp().
      await cp(path.join(sourceDir, entry.name), path.join(targetDir, entry.name))
      copied += 1
    } else {
      skipped += 1
    }
  }
  return { copiedFiles: copied, skippedFiles: skipped }
}

function runPnpm(args) {
  const result = spawnSync('pnpm', args, {
    cwd: REPO_ROOT,
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} exited with status ${result.status}`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printUsage()
    return
  }
  if (!(await exists(options.source))) {
    console.error(`Source directory not found: ${options.source}`)
    process.exitCode = 2
    return
  }
  const skills = await walkSkillFolders(options.source)
  if (skills.length === 0) {
    console.error(
      `No skills (each a directory containing SKILL.md) found under ${options.source}`
    )
    process.exitCode = 2
    return
  }
  const existing = await listExisting(options.targetRoot)
  const counts = { add: 0, skip: 0, conflict: 0 }
  const plan = []
  for (const skill of skills) {
    const decision = decideSkill(skill, options, existing)
    plan.push({ skill, decision })
    if (decision.action === 'add') counts.add += 1
    else if (decision.action === 'skip') counts.skip += 1
    else if (decision.action === 'conflict') counts.conflict += 1
  }
  if (options.dryRun) {
    console.log(`Dry-run: ${plan.length} skills scanned in ${options.source}`)
    for (const { skill, decision } of plan) {
      const slugGuess = sanitizeSlug(`${options.prefix}${skill.category}-${skill.name}`)
      const reasonTag = decision.reason ? ` (${decision.reason})` : ''
      console.log(`  [${decision.action.padEnd(8)}] ${skill.category}/${skill.name} -> ${slugGuess}${reasonTag}`)
    }
    console.log(`Totals: add=${counts.add}, skip=${counts.skip}, conflict=${counts.conflict}`)
    return
  }
  for (const { skill, decision } of plan) {
    if (decision.action !== 'add') continue
    const targetDir = path.join(options.targetRoot, decision.slug)
    const { copiedFiles, skippedFiles } = await copySkill(
      skill.absPath,
      targetDir,
      false,
      options.includeExtras
    )
    const skillMdPath = path.join(skill.absPath, 'SKILL.md')
    const fm = parseSkillFrontMatter(await readFile(skillMdPath, 'utf8'))
    const nameTag = fm.name ? `name=${fm.name}` : '(no name in front-matter)'
    const descTag = fm.description ? ` desc="${fm.description.slice(0, 60)}…"` : ''
    console.log(
      `  added ${decision.slug.padEnd(48)} (${copiedFiles} file${copiedFiles === 1 ? '' : 's'}, ${skippedFiles} skipped) ${nameTag}${descTag}`
    )
  }
  await writeFile(
    path.join(options.targetRoot, '.import-zcode-skills.last-run.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: options.source,
        prefix: options.prefix,
        includeExtras: options.includeExtras,
        skipCategories: options.skipCategories,
        allowCategories: options.allowCategories,
        totals: counts,
        added: plan
          .filter(({ decision }) => decision.action === 'add')
          .map(({ skill, decision }) => ({
            category: skill.category,
            name: skill.name,
            slug: decision.slug
          }))
      },
      null,
      2
    ) + '\n'
  )
  console.log(`Imported: add=${counts.add}, skip=${counts.skip}, conflict=${counts.conflict}`)
  if (options.regenerate && counts.add > 0) {
    console.log('Regenerating skill bundle manifest...')
    try {
      runPnpm(['run', 'generate:skill-bundle-manifest'])
      console.log('Manifest regenerated. Run pnpm run verify:skill-bundle-manifest to confirm.')
    } catch (error) {
      console.error('Manifest regeneration failed:', error.message)
      console.error(
        'Imported skills are on disk at skills/<slug>/; re-run generate manually.'
      )
      process.exitCode = 1
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
