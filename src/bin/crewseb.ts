#!/usr/bin/env node
import {
  type HostId,
  serializeWire,
  SUPPORTED_HOSTS,
  SystemRuntime,
  wireFailure,
  wireSuccess,
} from 'hubseb'
import { analyzeBudget, buildAgents, CREW_ROLES, writeAgents } from '../build.ts'
import { type CrewRole, loadPersonas, ROLE_META } from '../personas.ts'
import {
  auditCrewsebDirectives,
  BUNDLE_ID,
  CONSUMES,
  deployCrewseb,
  PROVIDES,
  purgeCrewseb,
  rerollAndDeploy,
  SIGNALS,
} from '../setup.ts'
import { VERSION } from '../version.ts'

function parseHostsOption(args: readonly string[]): HostId[] | undefined {
  const idx = args.indexOf('--agents')
  if (idx === -1) return undefined
  const val = args[idx + 1]
  if (!val || val === 'detected') return undefined
  if (val === 'all') return [...SUPPORTED_HOSTS]
  return val
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is HostId => (SUPPORTED_HOSTS as readonly string[]).includes(s))
}

export interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

export async function executeCrewCli(
  argv: readonly string[],
  runtime: SystemRuntime = new SystemRuntime(),
): Promise<CliResult> {
  const jsonMode = argv.includes('--json')
  const selectedHosts = parseHostsOption(argv)

  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--json') continue
    if (token === '--agents') {
      i++
      continue
    }
    positional.push(token)
  }

  const command = positional[0] ?? 'help'

  if (command === 'capabilities') {
    const payload = {
      id: BUNDLE_ID,
      version: VERSION,
      provides: PROVIDES,
      consumes: CONSUMES,
      signals: SIGNALS,
    }
    if (jsonMode) {
      return { exitCode: 0, stdout: serializeWire(wireSuccess('capabilities', payload)), stderr: '' }
    }
    return {
      exitCode: 0,
      stdout: `${BUNDLE_ID} v${VERSION}\nprovides: ${PROVIDES.join(', ')}\nconsumes: ${CONSUMES.join(', ')}\nsignals: ${SIGNALS.join(', ')}\n`,
      stderr: '',
    }
  }

  if (command === 'build') {
    const personas = await loadPersonas(runtime)
    const built = await buildAgents(personas)
    await writeAgents(built)
    if (jsonMode) {
      return {
        exitCode: 0,
        stdout: serializeWire(
          wireSuccess('build', { count: built.length, targets: SUPPORTED_HOSTS }),
        ),
        stderr: '',
      }
    }
    return {
      exitCode: 0,
      stdout: `Compiled ${built.length} specialists into subagents/ and targets/{antigravity,claude,codex,opencode}/.\n`,
      stderr: '',
    }
  }

  if (command === 'roster') {
    const personas = await loadPersonas(runtime)
    const roster = CREW_ROLES.map((role) => ({
      role,
      persona: personas[role],
      icon: ROLE_META[role].icon,
      title: ROLE_META[role].title,
      badge: `${ROLE_META[role].icon} [${personas[role]} · ${role}]`,
    }))
    if (jsonMode) {
      return { exitCode: 0, stdout: serializeWire(wireSuccess('roster', { roster })), stderr: '' }
    }
    const lines = ['Tripulación activa de crewseb:']
    for (const r of roster) {
      lines.push(`  ${r.icon}  ${r.persona.padEnd(10)} · ${r.role.padEnd(15)} (${r.title})`)
    }
    return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
  }

  if (command === 'reroll') {
    const targetRole = positional[1] as CrewRole | undefined
    if (targetRole && !CREW_ROLES.includes(targetRole)) {
      if (jsonMode) {
        return {
          exitCode: 2,
          stdout: serializeWire(
            wireFailure('reroll', 'INVALID_ROLE', `Unknown role "${targetRole}"`),
          ),
          stderr: '',
        }
      }
      return {
        exitCode: 2,
        stdout: '',
        stderr: `Unknown role "${targetRole}". Valid roles: ${CREW_ROLES.join(', ')}\n`,
      }
    }

    const res = await rerollAndDeploy(targetRole, { runtime, hosts: selectedHosts })
    if (jsonMode) {
      return { exitCode: 0, stdout: serializeWire(wireSuccess('reroll', res)), stderr: '' }
    }
    const lines = [
      targetRole
        ? `Nuevo nombre sorteado para ${targetRole}: ${ROLE_META[targetRole].icon} ${res.personas[targetRole]}`
        : '¡Nuevos nombres sorteados para toda la tripulación de crewseb!',
    ]
    for (const role of CREW_ROLES) {
      lines.push(`  ${ROLE_META[role].icon}  ${res.personas[role].padEnd(10)} · ${role}`)
    }
    return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
  }

  if (command === 'budget') {
    const personas = await loadPersonas(runtime)
    const report = await analyzeBudget(personas)
    if (jsonMode) {
      return {
        exitCode: report.withinBudget ? 0 : 1,
        stdout: serializeWire(wireSuccess('budget', report)),
        stderr: '',
      }
    }
    const lines = [
      `Presupuesto de Contexto de crewseb (${report.withinBudget ? '✓ ÓPTIMO' : '✗ EXCEDIDO'}):`,
      `  Summaries (10 especialistas): ${report.totalDescriptionChars} / ${report.maxDescriptionCharsLimit} chars (~${report.totalEstimatedDescriptionTokens} tokens)`,
      `  Directivas globales (RULES.md): ${report.rulesChars} / ${report.maxRulesCharsLimit} chars (~${report.estimatedRulesTokens} tokens)`,
      '',
      '  Desglose por especialista:',
    ]
    for (const a of report.agents) {
      lines.push(
        `    ${a.icon} ${a.persona.padEnd(9)} (${a.role.padEnd(14)}) — summary: ${String(a.descriptionChars).padStart(3)}/300 chars | body: ${String(a.bodyLines).padStart(2)}/80 lines`,
      )
    }
    return { exitCode: report.withinBudget ? 0 : 1, stdout: `${lines.join('\n')}\n`, stderr: '' }
  }

  if (command === 'setup') {
    const res = await deployCrewseb({ runtime, hosts: selectedHosts })
    if (jsonMode) {
      return { exitCode: 0, stdout: serializeWire(wireSuccess('setup', res)), stderr: '' }
    }
    const lines = [
      `Attached crewseb node to hubseb topology: ${res.topologyFile}`,
      'Host driver deployments:',
    ]
    for (const r of res.receipts) {
      lines.push(
        `  ✓ [${r.hostId}] sha256=${r.directivesHash ?? 'none'} (${r.writtenPaths.length} assets deployed)`,
      )
    }
    return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
  }

  if (command === 'check') {
    const reports = await auditCrewsebDirectives({ runtime, hosts: selectedHosts })
    const allVerified = reports.every((r) => r.status === 'verified')
    if (jsonMode) {
      return {
        exitCode: allVerified ? 0 : 1,
        stdout: serializeWire(wireSuccess('check', { allVerified, reports })),
        stderr: '',
      }
    }
    const lines = ['crewseb SHA-256 directive integrity check:']
    for (const r of reports) {
      lines.push(
        `  [${r.hostId}] ${r.status} (expected=${r.expectedHash}, actual=${r.actualHash ?? 'none'}) — ${r.directivesFile}`,
      )
    }
    return { exitCode: allVerified ? 0 : 1, stdout: `${lines.join('\n')}\n`, stderr: '' }
  }

  if (command === 'uninstall') {
    const res = await purgeCrewseb({ runtime, hosts: selectedHosts })
    if (jsonMode) {
      return { exitCode: 0, stdout: serializeWire(wireSuccess('uninstall', res)), stderr: '' }
    }
    const lines = [`Detached from hubseb topology: ${res.detachedFromTopology}`]
    for (const p of res.purged) {
      lines.push(
        `  [${p.hostId}] removed ${p.removedPaths.length} lock-tracked paths (directivesRemoved=${p.directivesRemoved})`,
      )
    }
    return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    const text = [
      `crewseb v${VERSION} — Specialist Subagent Crew with Random Personas & Multi-Host Compiler`,
      '',
      'Commands:',
      '  crewseb setup [--agents a,b|all]   Attach to hubseb topology & deploy across detected hosts',
      '  crewseb roster [--json]            Display the 10 specialists and their active random names',
      '  crewseb reroll [role] [--json]     Roll new random persona names and redeploy',
      '  crewseb budget [--json]            Audit token/character budget across all 10 specialists',
      '  crewseb check [--json]             Verify SHA-256 integrity of directives across hosts',
      '  crewseb build [--json]             Compile src/agents/*.md into targets/{antigravity,claude,codex,opencode}/',
      '  crewseb uninstall [--json]         Purge lock-tracked files from all hosts & detach from hubseb',
      '',
    ].join('\n')
    if (jsonMode) {
      return {
        exitCode: 0,
        stdout: serializeWire(
          wireSuccess('help', {
            commands: ['setup', 'roster', 'reroll', 'budget', 'check', 'build', 'uninstall'],
          }),
        ),
        stderr: '',
      }
    }
    return { exitCode: 0, stdout: text, stderr: '' }
  }

  if (jsonMode) {
    return {
      exitCode: 2,
      stdout: serializeWire(
        wireFailure(command, 'UNKNOWN_COMMAND', `Unknown command "${command}"`, 'Run "crewseb help"'),
      ),
      stderr: '',
    }
  }
  return {
    exitCode: 2,
    stdout: '',
    stderr: `Unknown command "${command}". Run "crewseb help".\n`,
  }
}

const isEntry =
  process.argv[1] &&
  (process.argv[1].endsWith('crewseb.ts') ||
    process.argv[1].endsWith('crewseb.js') ||
    process.argv[1].endsWith('/crewseb'))

if (isEntry) {
  executeCrewCli(process.argv.slice(2)).then((res) => {
    if (res.stdout) process.stdout.write(res.stdout)
    if (res.stderr) process.stderr.write(res.stderr)
    process.exitCode = res.exitCode
  })
}
