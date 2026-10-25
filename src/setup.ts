import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type BundlePayload,
  type DeploymentReceipt,
  DriverHub,
  type HostId,
  type HostIntegrityReport,
  type HostRootOverrides,
  parseSpecialistMarkdown,
  SystemRuntime,
  type ToolNodeRegistration,
  TopologyStore,
} from 'hubseb'
import {
  ANTIGRAVITY_RULES_FILE,
  buildAgents,
  RULES_FILE,
  SKILL_DIR,
  writeAgents,
} from './build.ts'
import { type CrewRole, ensurePersonas, loadPersonas, rerollPersonas } from './personas.ts'
import { PACKAGE_ROOT, VERSION } from './version.ts'

export const BUNDLE_ID = 'crewseb'
export const PROVIDES = ['crew.specialists', 'crew.personas', 'crew.directives']
export const CONSUMES = ['memory.vault', 'docs.engine']
export const SIGNALS = ['personas.rerolled', 'crew.deployed']

export function nodeRegistration(): ToolNodeRegistration {
  const distBin = path.join(PACKAGE_ROOT, 'dist', 'bin', 'crewseb.js')
  const srcBin = path.join(PACKAGE_ROOT, 'src', 'bin', 'crewseb.ts')
  const script = existsSync(distBin) ? distBin : srcBin
  return {
    id: BUNDLE_ID,
    version: VERSION,
    summary: 'Crewseb 10 specialist subagents with random personas and engineering protocols',
    command: [path.resolve(process.execPath), path.resolve(script)],
    provides: PROVIDES,
    consumes: CONSUMES,
    signals: SIGNALS,
  }
}

export async function assembleBundlePayload(
  personas?: Readonly<Record<CrewRole, string>>,
  runtime: SystemRuntime = new SystemRuntime(),
): Promise<BundlePayload> {
  const activePersonas = personas ?? (await loadPersonas(runtime))
  const built = await buildAgents(activePersonas)
  const specialists = built.map((b) => parseSpecialistMarkdown(b.content, 'claude'))
  const globalDirectives = await readFile(RULES_FILE, 'utf8')
  const alwaysOnRules = await readFile(ANTIGRAVITY_RULES_FILE, 'utf8')
  const skillMd = await readFile(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')

  return {
    bundleId: BUNDLE_ID,
    version: VERSION,
    summary: 'Crewseb specialist subagent crew and orchestration directives',
    globalDirectives,
    alwaysOnRules,
    specialists,
    skills: [
      {
        id: BUNDLE_ID,
        summary: 'Orquesta la tripulación de 10 especialistas de crewseb en cadena o en paralelo',
        markdownBody: skillMd,
      },
    ],
  }
}

export interface CrewSetupOptions {
  runtime?: SystemRuntime
  roots?: HostRootOverrides
  hosts?: readonly HostId[]
  rng?: () => number
}

export interface CrewSetupOutcome {
  topologyFile: string
  personas: Record<CrewRole, string>
  receipts: DeploymentReceipt[]
}

export async function deployCrewseb(options: CrewSetupOptions = {}): Promise<CrewSetupOutcome> {
  const runtime = options.runtime ?? new SystemRuntime()
  const personas = await ensurePersonas(runtime, options.rng)
  const built = await buildAgents(personas)
  await writeAgents(built)

  const topology = new TopologyStore(runtime)
  const { file: topologyFile } = await topology.attachNode(nodeRegistration())

  const driverHub = new DriverHub(runtime, options.roots)
  const payload = await assembleBundlePayload(personas, runtime)
  const receipts = await driverHub.deployToHosts(payload, options.hosts)

  await topology.broadcastSignal(BUNDLE_ID, 'crew.deployed', {
    version: VERSION,
    hosts: receipts.map((r) => r.hostId),
  })

  return {
    topologyFile,
    personas,
    receipts,
  }
}

export async function rerollAndDeploy(
  targetRole?: CrewRole,
  options: CrewSetupOptions = {},
): Promise<{
  personas: Record<CrewRole, string>
  personasFile: string
  receipts: DeploymentReceipt[]
}> {
  const runtime = options.runtime ?? new SystemRuntime()
  const { personas, file: personasFile } = await rerollPersonas(targetRole, runtime, options.rng)
  const built = await buildAgents(personas)
  await writeAgents(built)

  const driverHub = new DriverHub(runtime, options.roots)
  const payload = await assembleBundlePayload(personas, runtime)
  const receipts = await driverHub.deployToHosts(payload, options.hosts)

  const topology = new TopologyStore(runtime)
  await topology.broadcastSignal(BUNDLE_ID, 'personas.rerolled', {
    role: targetRole ?? 'all',
    personas,
  })

  return {
    personas,
    personasFile,
    receipts,
  }
}

export async function purgeCrewseb(options: CrewSetupOptions = {}): Promise<{
  detachedFromTopology: boolean
  purged: Array<{ hostId: HostId; removedPaths: string[]; directivesRemoved: boolean }>
}> {
  const runtime = options.runtime ?? new SystemRuntime()
  const driverHub = new DriverHub(runtime, options.roots)
  const purged = await driverHub.purgeFromHosts(BUNDLE_ID, options.hosts)

  const topology = new TopologyStore(runtime)
  const detachedFromTopology = await topology.detachNode(BUNDLE_ID)

  return {
    detachedFromTopology,
    purged,
  }
}

export async function auditCrewsebDirectives(
  options: CrewSetupOptions = {},
): Promise<HostIntegrityReport[]> {
  const runtime = options.runtime ?? new SystemRuntime()
  const driverHub = new DriverHub(runtime, options.roots)
  const rawDirectives = await readFile(RULES_FILE, 'utf8')
  return driverHub.auditHosts(BUNDLE_ID, rawDirectives, options.hosts)
}
