import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DriverHub,
  filterDialectBlocks,
  parseSpecialistMarkdown,
  type ReasoningTier,
  SUPPORTED_HOSTS,
} from 'hubseb'
import { type CrewModelsConfig, resolveRoleModels, ROLE_TIERS } from './models.ts'
import {
  CREW_ROLES,
  type CrewRole,
  DEFAULT_PERSONAS,
  renderPersonaLine,
  ROLE_META,
} from './personas.ts'
import { PACKAGE_ROOT } from './version.ts'

export const SOURCE_DIR = path.join(PACKAGE_ROOT, 'src', 'agents')
export const PROTOCOLS_DIR = path.join(PACKAGE_ROOT, 'src', 'protocols')
export const SUBAGENTS_DIR = path.join(PACKAGE_ROOT, 'subagents')
export const TARGETS_DIR = path.join(PACKAGE_ROOT, 'targets')
export const RULES_FILE = path.join(PACKAGE_ROOT, 'rules', 'RULES.md')
export const ANTIGRAVITY_RULES_FILE = path.join(PACKAGE_ROOT, 'rules', 'antigravity.md')
export const SKILL_DIR = path.join(PACKAGE_ROOT, 'skills', 'crewseb')

const PROTOCOL_TOKEN_RE = /^\{\{protocol:([a-z0-9-]+)\}\}\s*$/
const PERSONA_TOKEN_RE = /^\{\{persona:badge\}\}\s*$/

export const TARGET_AGENTS = SUPPORTED_HOSTS

export interface BuiltAgent {
  name: CrewRole
  personaName: string
  content: string
}

export function renderAgent(
  role: CrewRole,
  source: string,
  protocols: ReadonlyMap<string, string>,
  personas: Readonly<Record<CrewRole, string>> = DEFAULT_PERSONAS,
  modelsConfig?: CrewModelsConfig,
): string {
  const personaName = personas[role] ?? DEFAULT_PERSONAS[role]
  const lines = source.split(/\r?\n/).map((line) => {
    const trimmed = line.trim()
    if (PERSONA_TOKEN_RE.test(trimmed)) {
      return renderPersonaLine(role, personaName)
    }
    const match = PROTOCOL_TOKEN_RE.exec(trimmed)
    if (!match) return line
    const protocolContent = protocols.get(match[1] ?? '')
    if (protocolContent === undefined) {
      throw new Error(`Unknown protocol token: {{protocol:${match[1]}}}`)
    }
    return protocolContent.trim()
  })

  let rendered = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`

  if (modelsConfig) {
    const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n[\s\S]*)$/.exec(rendered)
    if (fmMatch) {
      const fmBody = fmMatch[1] ?? ''
      const rest = fmMatch[2] ?? ''
      const tierMatch = /^tier:\s*(fast|balanced|deep)\s*$/m.exec(fmBody)
      const tier: ReasoningTier = (tierMatch?.[1] as ReasoningTier | undefined) ?? ROLE_TIERS[role]
      const hostModels = resolveRoleModels(role, tier, modelsConfig)
      const extraLines: string[] = []
      for (const hostId of SUPPORTED_HOSTS) {
        const val = hostModels[hostId]
        if (val && !new RegExp(`^model\\.${hostId}:`, 'm').test(fmBody)) {
          extraLines.push(`model.${hostId}: ${val}`)
        }
      }
      if (extraLines.length > 0) {
        rendered = `---\n${fmBody}\n${extraLines.join('\n')}\n---${rest}`
      }
    }
  }

  return rendered
}

export function renderSkillMarkdown(rawSkill: string, modelsConfig?: CrewModelsConfig): string {
  if (!modelsConfig || modelsConfig.concurrency.mode === 'parallel') {
    return rawSkill
  }

  const { mode, maxLocalParallel, overflowTarget } = modelsConfig.concurrency
  const policyLine =
    mode === 'queue'
      ? `- **Modo Cola Activo (\`queue\`, maxLocal=${maxLocalParallel})**: Para evitar desbordar la VRAM de la GPU local, despacha como máximo ${maxLocalParallel} subagente(s) local(es) a la vez, encolando el resto secuencialmente.`
      : `- **Modo Mixto Activo (\`mixed\`, maxLocal=${maxLocalParallel}, overflow=${overflowTarget})**: Lanza hasta ${maxLocalParallel} subagente(s) local(es) simultáneos; si hay más tareas paralelas en el mismo turno, despacha el excedente usando agentes ligeros (${overflowTarget === 'lite' ? 'modelos lite' : 'cualquier modelo disponible'}).`

  if (rawSkill.includes('\n\n## 3. Corre la cadena')) {
    return rawSkill.replace('\n\n## 3. Corre la cadena', `\n${policyLine}\n\n## 3. Corre la cadena`)
  }
  return `${rawSkill.trimEnd()}\n${policyLine}\n`
}

async function markdownFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  return (await readdir(dir)).filter((file) => file.endsWith('.md')).sort()
}

export async function loadProtocols(dir: string = PROTOCOLS_DIR): Promise<Map<string, string>> {
  const protocols = new Map<string, string>()
  for (const file of await markdownFiles(dir)) {
    protocols.set(path.basename(file, '.md'), await readFile(path.join(dir, file), 'utf8'))
  }
  return protocols
}

export async function buildAgents(
  personas: Readonly<Record<CrewRole, string>> = DEFAULT_PERSONAS,
  sourceDir: string = SOURCE_DIR,
  protocolsDir: string = PROTOCOLS_DIR,
  modelsConfig?: CrewModelsConfig,
): Promise<BuiltAgent[]> {
  const protocols = await loadProtocols(protocolsDir)
  const built: BuiltAgent[] = []
  for (const file of await markdownFiles(sourceDir)) {
    const role = path.basename(file, '.md') as CrewRole
    const raw = await readFile(path.join(sourceDir, file), 'utf8')
    built.push({
      name: role,
      personaName: personas[role] ?? DEFAULT_PERSONAS[role],
      content: renderAgent(role, raw, protocols, personas, modelsConfig),
    })
  }
  return built
}

export async function writeAgents(
  built: readonly BuiltAgent[],
  subagentsDir: string = SUBAGENTS_DIR,
  targetsDir: string = TARGETS_DIR,
): Promise<void> {
  const driverHub = new DriverHub()
  await mkdir(subagentsDir, { recursive: true })
  for (const agent of built) {
    await writeFile(path.join(subagentsDir, `${agent.name}.md`), agent.content, 'utf8')
  }

  for (const targetHost of TARGET_AGENTS) {
    const outDir = path.join(targetsDir, targetHost)
    await mkdir(outDir, { recursive: true })
    for (const agent of built) {
      const converted = driverHub.compileSpecialistForHost(agent.content, targetHost)
      await writeFile(path.join(outDir, converted.filename), converted.content, 'utf8')
    }
  }
}

export interface AgentBudgetEntry {
  role: CrewRole
  persona: string
  icon: string
  descriptionChars: number
  bodyLines: number
  estimatedDescriptionTokens: number
}

export interface BudgetReport {
  agents: AgentBudgetEntry[]
  totalDescriptionChars: number
  maxDescriptionCharsLimit: number
  totalEstimatedDescriptionTokens: number
  rulesChars: number
  maxRulesCharsLimit: number
  estimatedRulesTokens: number
  withinBudget: boolean
}

export async function analyzeBudget(
  personas: Readonly<Record<CrewRole, string>> = DEFAULT_PERSONAS,
): Promise<BudgetReport> {
  const built = await buildAgents(personas)
  const entries: AgentBudgetEntry[] = []
  let totalDescriptionChars = 0

  for (const item of built) {
    const spec = parseSpecialistMarkdown(item.content, 'claude')
    const descChars = spec.summary.length
    const bodyLines = spec.instructions.split('\n').length
    totalDescriptionChars += descChars
    entries.push({
      role: item.name,
      persona: item.personaName,
      icon: ROLE_META[item.name]?.icon ?? '🤖',
      descriptionChars: descChars,
      bodyLines,
      estimatedDescriptionTokens: Math.ceil(descChars / 4),
    })
  }

  const rulesRaw = await readFile(RULES_FILE, 'utf8')
  const rulesRendered = filterDialectBlocks(rulesRaw, 'claude').trim()
  const rulesChars = rulesRendered.length
  const maxDescriptionCharsLimit = 2500
  const maxRulesCharsLimit = 5200

  const withinBudget =
    totalDescriptionChars <= maxDescriptionCharsLimit &&
    rulesChars <= maxRulesCharsLimit &&
    entries.every((e) => e.descriptionChars <= 300 && e.bodyLines <= 80)

  return {
    agents: entries,
    totalDescriptionChars,
    maxDescriptionCharsLimit,
    totalEstimatedDescriptionTokens: Math.ceil(totalDescriptionChars / 4),
    rulesChars,
    maxRulesCharsLimit,
    estimatedRulesTokens: Math.ceil(rulesChars / 4),
    withinBudget,
  }
}

export { CREW_ROLES }
