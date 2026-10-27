#!/usr/bin/env node
import {
  type HostId,
  type ReasoningTier,
  serializeWire,
  SUPPORTED_HOSTS,
  SystemRuntime,
  wireFailure,
  wireSuccess,
} from 'hubseb'
import { analyzeBudget, buildAgents, CREW_ROLES, writeAgents } from '../build.ts'
import { assessVramCapacity, detectGpu, validateLocalConcurrency } from '../gpu.ts'
import {
  applyModelPreset,
  type ConcurrencyMode,
  type CrewConcurrencyConfig,
  effectiveDisplayModel,
  hasLocalModels,
  loadModelsConfig,
  type ModelPresetName,
  modelsFilePath,
  normalizeOllamaModel,
  type OverflowTarget,
  resetModelsConfig,
  ROLE_TIERS,
  setConcurrencyConfig,
  setRoleModel,
  setTierModel,
} from '../models.ts'
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
  syncModelsAndDeploy,
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

function parseFlagValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  return args[idx + 1]
}

const VALUE_FLAGS = new Set([
  '--agents',
  '--host',
  '--model',
  '--fast',
  '--balanced',
  '--deep',
  '--mode',
  '--max-local',
  '--overflow',
  '--local-model',
  '--lite-model',
])

const VALID_PRESET_ARGS = new Set<ModelPresetName>([
  'default',
  'lite',
  'hard',
  'hybrid',
  'ollama',
  'cloud-tiered',
  'custom',
])

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
  const forceMode = argv.includes('--force')
  const selectedHosts = parseHostsOption(argv)

  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--json' || token === '--force') continue
    if (VALUE_FLAGS.has(token)) {
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

  if (command === 'gpu') {
    const modelOpt = parseFlagValue(argv, '--model') ?? 'ollama/qwen2.5-coder:7b'
    const gpu = await detectGpu(runtime)
    const assessment = assessVramCapacity(gpu, modelOpt)
    if (jsonMode) {
      return {
        exitCode: 0,
        stdout: serializeWire(wireSuccess('gpu', { gpu, assessment })),
        stderr: '',
      }
    }
    const lines = [
      'Diagnóstico de GPU y capacidad VRAM para crewseb:',
      `  GPU: ${gpu.name} (vendor=${gpu.vendor}, source=${gpu.source}, detected=${gpu.detected})`,
      `  VRAM: ${gpu.vramMb} MB total | ${gpu.freeVramMb} MB libre`,
      `  Modelo de referencia: ${assessment.modelTag} (~${assessment.weightsMb} MB pesos + ~${assessment.kvSlotMb} MB/agente)`,
      `  Agentes locales simultáneos soportados: ${assessment.maxConcurrentAgents}`,
      `  Modo de concurrencia recomendado: ${assessment.recommendedMode}`,
      `  Resumen: ${assessment.summary}`,
    ]
    return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
  }

  if (command === 'build') {
    const personas = await loadPersonas(runtime)
    const modelsConfig = await loadModelsConfig(runtime)
    const built = await buildAgents(personas, undefined, undefined, modelsConfig)
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

  if (command === 'models') {
    const sub = positional[1] ?? 'list'
    const hostFlag = parseFlagValue(argv, '--host') as HostId | '*' | undefined
    if (
      hostFlag &&
      hostFlag !== '*' &&
      !(SUPPORTED_HOSTS as readonly string[]).includes(hostFlag)
    ) {
      const msg = `Unsupported host "${hostFlag}". Valid hosts: ${SUPPORTED_HOSTS.join(', ')}`
      if (jsonMode) {
        return {
          exitCode: 2,
          stdout: serializeWire(wireFailure('models', 'INVALID_HOST', msg)),
          stderr: '',
        }
      }
      return { exitCode: 2, stdout: '', stderr: `${msg}\n` }
    }

    if (sub === 'list') {
      const config = await loadModelsConfig(runtime)
      const personas = await loadPersonas(runtime)
      const matrix = CREW_ROLES.map((role) => {
        const tier = ROLE_TIERS[role]
        return {
          role,
          persona: personas[role],
          icon: ROLE_META[role].icon,
          tier,
          models: {
            antigravity: effectiveDisplayModel(role, tier, 'antigravity', config),
            claude: effectiveDisplayModel(role, tier, 'claude', config),
            codex: effectiveDisplayModel(role, tier, 'codex', config),
            opencode: effectiveDisplayModel(role, tier, 'opencode', config),
          },
        }
      })
      if (jsonMode) {
        return {
          exitCode: 0,
          stdout: serializeWire(
            wireSuccess('models', {
              file: modelsFilePath(runtime),
              preset: config.preset,
              concurrency: config.concurrency,
              config,
              matrix,
            }),
          ),
          stderr: '',
        }
      }
      const lines = [
        `Configuración de modelos de crewseb (preset: ${config.preset}):`,
        `  Archivo: ${modelsFilePath(runtime)}`,
        `  Concurrencia: modo=${config.concurrency.mode} | maxLocalParallel=${config.concurrency.maxLocalParallel} | overflow=${config.concurrency.overflowTarget}`,
        '',
      ]
      for (const row of matrix) {
        lines.push(
          `  ${row.icon}  ${row.role.padEnd(14)} [${row.tier.padEnd(8)}] → opencode=${row.models.opencode} | codex=${row.models.codex} | claude=${row.models.claude} | agy=${row.models.antigravity}`,
        )
      }
      return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
    }

    if (sub === 'preset') {
      const presetName = positional[2] as ModelPresetName | undefined
      if (!presetName || !VALID_PRESET_ARGS.has(presetName)) {
        const msg =
          'Usage: crewseb models preset <default|lite|hard|hybrid|ollama|cloud-tiered> [--model <m>] [--local-model <m>] [--lite-model <m>] [--fast <m>] [--balanced <m>] [--deep <m>] [--mode <parallel|queue|mixed>] [--max-local <n>] [--overflow <lite|any>] [--force]'
        if (jsonMode) {
          return {
            exitCode: 2,
            stdout: serializeWire(wireFailure('models', 'INVALID_PRESET', msg)),
            stderr: '',
          }
        }
        return { exitCode: 2, stdout: '', stderr: `${msg}\n` }
      }

      const modelOpt = parseFlagValue(argv, '--model')
      const localModelOpt = parseFlagValue(argv, '--local-model')
      const liteModelOpt = parseFlagValue(argv, '--lite-model')
      const fastOpt = parseFlagValue(argv, '--fast')
      const balancedOpt = parseFlagValue(argv, '--balanced')
      const deepOpt = parseFlagValue(argv, '--deep')
      const modeOpt = parseFlagValue(argv, '--mode') as ConcurrencyMode | undefined
      const maxLocalRaw = parseFlagValue(argv, '--max-local')
      const overflowOpt = parseFlagValue(argv, '--overflow') as OverflowTarget | undefined

      if (modeOpt && modeOpt !== 'parallel' && modeOpt !== 'queue' && modeOpt !== 'mixed') {
        const msg = `Invalid concurrency mode "${modeOpt}". Valid modes: parallel, queue, mixed`
        if (jsonMode) {
          return {
            exitCode: 2,
            stdout: serializeWire(wireFailure('models', 'INVALID_CONCURRENCY', msg)),
            stderr: '',
          }
        }
        return { exitCode: 2, stdout: '', stderr: `${msg}\n` }
      }

      if (overflowOpt && overflowOpt !== 'lite' && overflowOpt !== 'any') {
        const msg = `Invalid overflow target "${overflowOpt}". Valid overflow targets: lite, any`
        if (jsonMode) {
          return {
            exitCode: 2,
            stdout: serializeWire(wireFailure('models', 'INVALID_CONCURRENCY', msg)),
            stderr: '',
          }
        }
        return { exitCode: 2, stdout: '', stderr: `${msg}\n` }
      }

      let maxLocalNum: number | undefined
      if (maxLocalRaw !== undefined) {
        const parsed = Number(maxLocalRaw)
        if (!Number.isInteger(parsed) || parsed < 1) {
          const msg = `Invalid --max-local value "${maxLocalRaw}". Must be an integer >= 1`
          if (jsonMode) {
            return {
              exitCode: 2,
              stdout: serializeWire(wireFailure('models', 'INVALID_CONCURRENCY', msg)),
              stderr: '',
            }
          }
          return { exitCode: 2, stdout: '', stderr: `${msg}\n` }
        }
        maxLocalNum = parsed
      }

      const isLocalPreset =
        presetName === 'ollama' || presetName === 'hybrid' || presetName === 'custom'
      const concurrencyPatch: Partial<CrewConcurrencyConfig> = {}
      if (modeOpt) concurrencyPatch.mode = modeOpt
      if (overflowOpt) concurrencyPatch.overflowTarget = overflowOpt

      if (isLocalPreset || maxLocalNum !== undefined) {
        const refLocalModel = normalizeOllamaModel(
          fastOpt ?? localModelOpt ?? modelOpt ?? 'ollama/qwen2.5-coder:7b',
        )
        const gpu = await detectGpu(runtime)
        const assessment = assessVramCapacity(gpu, refLocalModel)

        if (maxLocalNum !== undefined || (isLocalPreset && modeOpt === 'parallel')) {
          const requestedParallel = maxLocalNum ?? 2
          const validation = validateLocalConcurrency({
            gpu,
            requestedParallel,
            modelTag: refLocalModel,
            force: forceMode,
          })
          if (!validation.allowed) {
            const errMsg = validation.reason ?? 'VRAM limit exceeded for local model concurrency'
            if (jsonMode) {
              return {
                exitCode: 2,
                stdout: serializeWire(wireFailure('models', 'VRAM_LIMIT_EXCEEDED', errMsg)),
                stderr: '',
              }
            }
            return { exitCode: 2, stdout: '', stderr: `${errMsg}\n` }
          }
        }

        if (maxLocalNum !== undefined) {
          concurrencyPatch.maxLocalParallel = maxLocalNum
        } else if (isLocalPreset) {
          concurrencyPatch.maxLocalParallel =
            assessment.maxConcurrentAgents > 0
              ? Math.max(1, Math.min(assessment.maxConcurrentAgents, 2))
              : 1
        }
      }

      const targetPresetHosts = hostFlag && hostFlag !== '*' ? [hostFlag] : undefined
      const { config } = await applyModelPreset(
        presetName,
        {
          ...(modelOpt ? { model: modelOpt } : {}),
          ...(localModelOpt ? { localModel: localModelOpt } : {}),
          ...(liteModelOpt ? { liteModel: liteModelOpt } : {}),
          ...(fastOpt ? { fast: fastOpt } : {}),
          ...(balancedOpt ? { balanced: balancedOpt } : {}),
          ...(deepOpt ? { deep: deepOpt } : {}),
          ...(targetPresetHosts ? { hosts: targetPresetHosts } : {}),
          ...(Object.keys(concurrencyPatch).length > 0 ? { concurrency: concurrencyPatch } : {}),
        },
        runtime,
      )
      const outcome = await syncModelsAndDeploy(config, { runtime, hosts: selectedHosts })
      if (jsonMode) {
        return { exitCode: 0, stdout: serializeWire(wireSuccess('models', outcome)), stderr: '' }
      }
      return {
        exitCode: 0,
        stdout: `Applied model preset "${config.preset}" [mode=${config.concurrency.mode}, maxLocal=${config.concurrency.maxLocalParallel}] (${outcome.modelsFile}) and redeployed across ${outcome.receipts.length} host(s).\n`,
        stderr: '',
      }
    }

    if (sub === 'concurrency') {
      const modeArg = positional[2] as ConcurrencyMode | undefined
      const maxLocalRaw = parseFlagValue(argv, '--max-local')
      const overflowOpt = parseFlagValue(argv, '--overflow') as OverflowTarget | undefined

      if (!modeArg || (modeArg !== 'parallel' && modeArg !== 'queue' && modeArg !== 'mixed')) {
        const msg =
          'Usage: crewseb models concurrency <parallel|queue|mixed> [--max-local <n>] [--overflow <lite|any>] [--force]'
        if (jsonMode) {
          return {
            exitCode: 2,
            stdout: serializeWire(wireFailure('models', 'INVALID_CONCURRENCY', msg)),
            stderr: '',
          }
        }
        return { exitCode: 2, stdout: '', stderr: `${msg}\n` }
      }

      if (overflowOpt && overflowOpt !== 'lite' && overflowOpt !== 'any') {
        const msg = `Invalid overflow target "${overflowOpt}". Valid overflow targets: lite, any`
        if (jsonMode) {
          return {
            exitCode: 2,
            stdout: serializeWire(wireFailure('models', 'INVALID_CONCURRENCY', msg)),
            stderr: '',
          }
        }
        return { exitCode: 2, stdout: '', stderr: `${msg}\n` }
      }

      let maxLocalNum: number | undefined
      if (maxLocalRaw !== undefined) {
        const parsed = Number(maxLocalRaw)
        if (!Number.isInteger(parsed) || parsed < 1) {
          const msg = `Invalid --max-local value "${maxLocalRaw}". Must be an integer >= 1`
          if (jsonMode) {
            return {
              exitCode: 2,
              stdout: serializeWire(wireFailure('models', 'INVALID_CONCURRENCY', msg)),
              stderr: '',
            }
          }
          return { exitCode: 2, stdout: '', stderr: `${msg}\n` }
        }
        maxLocalNum = parsed
      }

      const current = await loadModelsConfig(runtime)
      const gpu = await detectGpu(runtime)
      const localInfo = hasLocalModels(current)
      const refModel = localInfo.primaryLocalModel ?? 'ollama/qwen2.5-coder:7b'

      if (maxLocalNum !== undefined || (modeArg === 'parallel' && localInfo.hasLocal)) {
        const requestedParallel = maxLocalNum ?? 2
        const validation = validateLocalConcurrency({
          gpu,
          requestedParallel,
          modelTag: refModel,
          force: forceMode,
        })
        if (!validation.allowed) {
          const errMsg = validation.reason ?? 'VRAM limit exceeded for local model concurrency'
          if (jsonMode) {
            return {
              exitCode: 2,
              stdout: serializeWire(wireFailure('models', 'VRAM_LIMIT_EXCEEDED', errMsg)),
              stderr: '',
            }
          }
          return { exitCode: 2, stdout: '', stderr: `${errMsg}\n` }
        }
      }

      const patch: Partial<CrewConcurrencyConfig> = {
        mode: modeArg,
        ...(maxLocalNum !== undefined ? { maxLocalParallel: maxLocalNum } : {}),
        ...(overflowOpt ? { overflowTarget: overflowOpt } : {}),
      }
      const { config } = await setConcurrencyConfig(patch, runtime)
      const outcome = await syncModelsAndDeploy(config, { runtime, hosts: selectedHosts })
      if (jsonMode) {
        return { exitCode: 0, stdout: serializeWire(wireSuccess('models', outcome)), stderr: '' }
      }
      return {
        exitCode: 0,
        stdout: `Updated concurrency policy → mode=${config.concurrency.mode}, maxLocalParallel=${config.concurrency.maxLocalParallel}, overflow=${config.concurrency.overflowTarget} and redeployed.\n`,
        stderr: '',
      }
    }

    if (sub === 'set') {
      const role = positional[2] as CrewRole | undefined
      const model = positional[3]
      if (!role || !CREW_ROLES.includes(role) || !model) {
        const msg = `Usage: crewseb models set <role> <model> [--host <host>]. Valid roles: ${CREW_ROLES.join(', ')}`
        if (jsonMode) {
          return {
            exitCode: 2,
            stdout: serializeWire(wireFailure('models', 'INVALID_ARGS', msg)),
            stderr: '',
          }
        }
        return { exitCode: 2, stdout: '', stderr: `${msg}\n` }
      }
      const { config } = await setRoleModel(role, model, hostFlag ?? '*', runtime)
      const outcome = await syncModelsAndDeploy(config, { runtime, hosts: selectedHosts })
      if (jsonMode) {
        return { exitCode: 0, stdout: serializeWire(wireSuccess('models', outcome)), stderr: '' }
      }
      return {
        exitCode: 0,
        stdout: `Updated model for ${role} (${hostFlag ?? 'all hosts'}) → ${model} and redeployed.\n`,
        stderr: '',
      }
    }

    if (sub === 'set-tier') {
      const tier = positional[2] as ReasoningTier | undefined
      const model = positional[3]
      if (!tier || (tier !== 'fast' && tier !== 'balanced' && tier !== 'deep') || !model) {
        const msg = 'Usage: crewseb models set-tier <fast|balanced|deep> <model> [--host <host>]'
        if (jsonMode) {
          return {
            exitCode: 2,
            stdout: serializeWire(wireFailure('models', 'INVALID_TIER', msg)),
            stderr: '',
          }
        }
        return { exitCode: 2, stdout: '', stderr: `${msg}\n` }
      }
      const { config } = await setTierModel(tier, model, hostFlag ?? '*', runtime)
      const outcome = await syncModelsAndDeploy(config, { runtime, hosts: selectedHosts })
      if (jsonMode) {
        return { exitCode: 0, stdout: serializeWire(wireSuccess('models', outcome)), stderr: '' }
      }
      return {
        exitCode: 0,
        stdout: `Updated tier "${tier}" (${hostFlag ?? 'all hosts'}) → ${model} and redeployed.\n`,
        stderr: '',
      }
    }

    if (sub === 'reset') {
      const role = positional[2] as CrewRole | undefined
      if (role && !CREW_ROLES.includes(role)) {
        const msg = `Unknown role "${role}". Valid roles: ${CREW_ROLES.join(', ')}`
        if (jsonMode) {
          return {
            exitCode: 2,
            stdout: serializeWire(wireFailure('models', 'INVALID_ROLE', msg)),
            stderr: '',
          }
        }
        return { exitCode: 2, stdout: '', stderr: `${msg}\n` }
      }
      const { config } = await resetModelsConfig(role, hostFlag, runtime)
      const outcome = await syncModelsAndDeploy(config, { runtime, hosts: selectedHosts })
      if (jsonMode) {
        return { exitCode: 0, stdout: serializeWire(wireSuccess('models', outcome)), stderr: '' }
      }
      return {
        exitCode: 0,
        stdout: `Reset model overrides (${role ?? 'all roles'}) and redeployed.\n`,
        stderr: '',
      }
    }

    const msg = `Unknown models subcommand "${sub}". Valid: list, preset, concurrency, set, set-tier, reset`
    if (jsonMode) {
      return {
        exitCode: 2,
        stdout: serializeWire(wireFailure('models', 'UNKNOWN_SUBCOMMAND', msg)),
        stderr: '',
      }
    }
    return { exitCode: 2, stdout: '', stderr: `${msg}\n` }
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
      '  crewseb models [list|preset|concurrency|set|set-tier|reset]  Configure models, presets (default|lite|hard|hybrid|ollama|cloud-tiered) & concurrency',
      '  crewseb gpu [--model <tag>] [--json]  Detect GPU VRAM capacity and recommended local concurrency',
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
            commands: [
              'setup',
              'roster',
              'reroll',
              'models',
              'gpu',
              'budget',
              'check',
              'build',
              'uninstall',
            ],
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
