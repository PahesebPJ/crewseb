import {
  EFFORT_LEVELS,
  type HostId,
  isAgyTier,
  isEffortLevel,
  serializeWire,
  SUPPORTED_HOSTS,
  SystemRuntime,
  wireFailure,
  wireSuccess,
} from 'hubseb'
import { checkModel, loadCatalog } from './catalog.ts'
import {
  type CrewModelsConfig,
  loadModelsConfig,
  resolveRole,
  setRoleAgyTier,
  setRoleEffort,
  setRoleModel,
  setRoleRouting,
} from './models.ts'
import { CREW_ROLES, type CrewRole } from './personas.ts'
import { syncModelsAndDeploy } from './setup.ts'

export interface ModelsCliResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface ModelsCliContext {
  sub: string
  positional: readonly string[]
  argv: readonly string[]
  runtime: SystemRuntime
  jsonMode: boolean
  hostFlag: HostId | '*' | undefined
  selectedHosts: HostId[] | undefined
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

function fail(ctx: ModelsCliContext, code: string, msg: string, exitCode = 2): ModelsCliResult {
  return ctx.jsonMode
    ? { exitCode, stdout: serializeWire(wireFailure('models', code, msg)), stderr: '' }
    : { exitCode, stdout: '', stderr: `${msg}\n` }
}

function isRole(v: unknown): v is CrewRole {
  return typeof v === 'string' && (CREW_ROLES as readonly string[]).includes(v)
}

function parseHost(v: string | undefined): HostId | null {
  if (v === 'agy' || v === 'gemini') return 'antigravity'
  return (SUPPORTED_HOSTS as readonly string[]).includes(v ?? '') ? (v as HostId) : null
}

async function deploy(ctx: ModelsCliContext, config: CrewModelsConfig, text: string, warnings: string[]): Promise<ModelsCliResult> {
  const outcome = await syncModelsAndDeploy(config, { runtime: ctx.runtime, hosts: ctx.selectedHosts })
  if (ctx.jsonMode) {
    return { exitCode: 0, stdout: serializeWire(wireSuccess('models', { ...outcome, warnings })), stderr: '' }
  }
  return { exitCode: 0, stdout: `${text} y redesplegado.\n`, stderr: warnings.map((w) => `⚠ ${w}\n`).join('') }
}

/** Role × host matrix with what each native frontmatter gets and what only sebshell can apply. */
export function describeRole(config: CrewModelsConfig, role: CrewRole) {
  return resolveRole(role, config)
}

/**
 * Handles `models set|effort|route|catalog|resolve`. Returns null for subcommands it does not own.
 */
export async function runExtendedModelsCommand(ctx: ModelsCliContext): Promise<ModelsCliResult | null> {
  const { sub, positional, argv, runtime } = ctx

  if (sub === 'set') {
    const role = positional[2]
    const model = positional[3]
    const effortArg = flag(argv, '--effort')
    const tierArg = flag(argv, '--tier')
    if (!isRole(role) || !model) {
      return fail(ctx, 'INVALID_ARGS', `Uso: crewseb models set <rol> <modelo> [--host <host>] [--effort <${EFFORT_LEVELS.join('|')}>] [--tier <inherit|flash_lite|flash|pro>]. Roles: ${CREW_ROLES.join(', ')}`)
    }
    if (effortArg !== undefined && !isEffortLevel(effortArg)) return fail(ctx, 'INVALID_EFFORT', `Esfuerzo inválido "${effortArg}". Válidos: ${EFFORT_LEVELS.join(', ')}`)
    if (tierArg !== undefined && !isAgyTier(tierArg)) return fail(ctx, 'INVALID_TIER', `Tier de agy inválido "${tierArg}". Válidos: inherit, flash_lite, flash, pro`)
    const host = ctx.hostFlag ?? '*'
    if (tierArg && host !== 'antigravity') return fail(ctx, 'INVALID_ARGS', '--tier solo aplica con --host antigravity')

    const warnings: string[] = []
    for (const h of host === '*' ? (['claude', 'antigravity'] as const) : [host]) {
      const check = checkModel(await loadCatalog(h, runtime), model, isEffortLevel(effortArg) ? effortArg : null)
      if (check.warning) warnings.push(check.warning)
    }
    let { config } = await setRoleModel(role, model, host, runtime)
    if (effortArg) ({ config } = await setRoleEffort(role, effortArg, host, runtime))
    if (tierArg) ({ config } = await setRoleAgyTier(role, tierArg, runtime))
    const agy = resolveRole(role, config).hosts.antigravity
    if ((host === 'antigravity' || host === '*') && agy.appliedAt === 'invocation') {
      warnings.push(`En agy, ${model}${effortArg ? `@${effortArg}` : ''} se aplica cuando sebshell invoca a ${role}; los subagentes que agy lanza por su cuenta usan el tier nativo "${agy.native}"${tierArg ? '' : ' (fíjalo con --tier)'}.`)
    }
    return deploy(ctx, config, `Modelo de ${role} (${host === '*' ? 'todos los hosts' : host}) → ${model}${effortArg ? ` · esfuerzo ${effortArg}` : ''}`, warnings)
  }

  if (sub === 'effort') {
    const role = positional[2]
    const effortArg = positional[3]
    if (!isRole(role) || !effortArg) return fail(ctx, 'INVALID_ARGS', `Uso: crewseb models effort <rol> <${EFFORT_LEVELS.join('|')}|none> [--host <host>]`)
    if (effortArg !== 'none' && !isEffortLevel(effortArg)) return fail(ctx, 'INVALID_EFFORT', `Esfuerzo inválido "${effortArg}". Válidos: ${EFFORT_LEVELS.join(', ')}, none`)
    const host = ctx.hostFlag ?? '*'
    const { config } = await setRoleEffort(role, effortArg === 'none' ? null : effortArg, host, runtime)
    return deploy(ctx, config, `Esfuerzo de ${role} (${host === '*' ? 'todos los hosts' : host}) → ${effortArg}`, [])
  }

  if (sub === 'route') {
    const role = positional[2]
    const target = positional[3]
    if (!isRole(role) || !target) return fail(ctx, 'INVALID_ARGS', 'Uso: crewseb models route <rol> <claude|antigravity|agy|none>')
    const host = target === 'none' ? null : parseHost(target)
    if (target !== 'none' && !host) return fail(ctx, 'INVALID_HOST', `Host inválido "${target}"`)
    const { config } = await setRoleRouting(role, host, runtime)
    return deploy(ctx, config, host ? `${role} se ejecutará en ${host} (vía seb_delegate)` : `${role} se ejecutará en el host orquestador`, [])
  }

  if (sub === 'catalog') {
    const hosts: HostId[] = ctx.hostFlag && ctx.hostFlag !== '*' ? [ctx.hostFlag] : ['claude', 'antigravity']
    const refresh = argv.includes('--refresh')
    const catalogs = await Promise.all(hosts.map((h) => loadCatalog(h, runtime, { refresh })))
    if (ctx.jsonMode) return { exitCode: 0, stdout: serializeWire(wireSuccess('models.catalog', { catalogs })), stderr: '' }
    const lines: string[] = []
    for (const c of catalogs) {
      lines.push(`${c.host} (${c.source}${c.fetchedAt ? `, ${c.fetchedAt}` : ''}):`)
      for (const m of c.models) {
        const efforts = m.nativeTier ? 'tier nativo, sin esfuerzo' : m.efforts.length > 0 ? m.efforts.join('/') : '—'
        lines.push(`  ${m.id.padEnd(30)} ${m.label.padEnd(30)} ${efforts}`)
      }
    }
    return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
  }

  if (sub === 'resolve') {
    const config = await loadModelsConfig(runtime)
    const role = positional[2]
    if (role !== undefined && !isRole(role)) return fail(ctx, 'INVALID_ROLE', `Rol desconocido "${role}"`)
    const roles = role ? [describeRole(config, role)] : CREW_ROLES.map((r) => describeRole(config, r))
    if (ctx.jsonMode) return { exitCode: 0, stdout: serializeWire(wireSuccess('models.resolve', { roles })), stderr: '' }
    const lines = roles.map((r) => {
      const c = r.hosts.claude
      const a = r.hosts.antigravity
      const agy = a.appliedAt === 'invocation' ? `${a.model}${a.effort ? `@${a.effort}` : ''} (nativo ${a.native})` : a.native
      return `  ${r.role.padEnd(14)} corre en: ${(r.runsOn ?? 'orquestador').padEnd(12)} claude=${c.native}${c.effort ? `@${c.effort}` : ''}  agy=${agy}`
    })
    return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
  }

  return null
}
