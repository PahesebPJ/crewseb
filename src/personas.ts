import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SystemRuntime } from 'hubseb'

export const CREW_ROLES = [
  'researcher',
  'analyst',
  'architect',
  'developer',
  'qa-automation',
  'devops',
  'sre',
  'security',
  'code-reviewer',
  'documenter',
] as const

export type CrewRole = (typeof CREW_ROLES)[number]

export const ROLE_META: Record<CrewRole, { icon: string; title: string }> = {
  researcher: { icon: '🔍', title: 'Investigador' },
  analyst: { icon: '📋', title: 'Analista Funcional' },
  architect: { icon: '🏛️', title: 'Arquitecto de Soluciones' },
  developer: { icon: '🛠️', title: 'Desarrollador' },
  'qa-automation': { icon: '🧪', title: 'QA Automation' },
  devops: { icon: '🚀', title: 'DevOps' },
  sre: { icon: '📡', title: 'SRE' },
  security: { icon: '🛡️', title: 'Seguridad' },
  'code-reviewer': { icon: '👁️', title: 'Revisor de Código' },
  documenter: { icon: '📚', title: 'Documentador' },
}

export const PERSONA_NAME_POOL = [
  'Kael',
  'Lyra',
  'Orion',
  'Nova',
  'Soren',
  'Vex',
  'Freya',
  'Atlas',
  'Zane',
  'Milo',
  'Astrid',
  'Dante',
  'Iris',
  'Jax',
  'Kira',
  'Leo',
  'Maya',
  'Niko',
  'Rhea',
  'Taro',
  'Vera',
  'Axel',
  'Cleo',
  'Echo',
  'Enzo',
  'Gael',
  'Juno',
  'Kai',
  'Luna',
  'Theo',
  'Caspian',
  'Nyx',
  'Vega',
  'Drako',
  'Elio',
  'Sable',
] as const

export const DEFAULT_PERSONAS: Record<CrewRole, string> = {
  researcher: 'Lyra',
  analyst: 'Soren',
  architect: 'Atlas',
  developer: 'Kael',
  'qa-automation': 'Nova',
  devops: 'Orion',
  sre: 'Vex',
  security: 'Freya',
  'code-reviewer': 'Zane',
  documenter: 'Milo',
}

export interface PersonaRoster {
  updatedAt: string
  personas: Record<CrewRole, string>
}

export function personasFilePath(runtime: SystemRuntime = new SystemRuntime()): string {
  const override = runtime.env.CREWSEB_PERSONAS_FILE
  if (override && override.trim().length > 0) return path.resolve(override)
  return path.join(runtime.configRoot, 'crewseb-personas.json')
}

function pickRandomNames(
  count: number,
  exclude: ReadonlySet<string> = new Set(),
  rng: () => number = Math.random,
): string[] {
  const available = PERSONA_NAME_POOL.filter((n) => !exclude.has(n))
  const pool = [...(available.length >= count ? available : PERSONA_NAME_POOL)]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = pool[i]!
    pool[i] = pool[j]!
    pool[j] = tmp
  }
  return pool.slice(0, count)
}

export function generateRandomPersonas(
  previous?: Partial<Record<CrewRole, string>>,
  rng: () => number = Math.random,
): Record<CrewRole, string> {
  const prevValues = new Set(Object.values(previous ?? {}).filter((v): v is string => Boolean(v)))
  const chosen = pickRandomNames(CREW_ROLES.length, prevValues, rng)
  const out = {} as Record<CrewRole, string>
  for (let i = 0; i < CREW_ROLES.length; i++) {
    const role = CREW_ROLES[i]!
    out[role] = chosen[i] ?? DEFAULT_PERSONAS[role]
  }
  return out
}

export async function loadPersonas(
  runtime: SystemRuntime = new SystemRuntime(),
): Promise<Record<CrewRole, string>> {
  const file = personasFilePath(runtime)
  if (!existsSync(file)) {
    return { ...DEFAULT_PERSONAS }
  }
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<PersonaRoster>
    const map = { ...DEFAULT_PERSONAS }
    if (raw.personas && typeof raw.personas === 'object') {
      for (const role of CREW_ROLES) {
        const val = raw.personas[role]
        if (typeof val === 'string' && val.trim().length > 0) {
          map[role] = val.trim()
        }
      }
    }
    return map
  } catch {
    return { ...DEFAULT_PERSONAS }
  }
}

export async function savePersonas(
  personas: Record<CrewRole, string>,
  runtime: SystemRuntime = new SystemRuntime(),
): Promise<string> {
  const file = personasFilePath(runtime)
  await mkdir(path.dirname(file), { recursive: true })
  const data: PersonaRoster = {
    updatedAt: new Date().toISOString(),
    personas,
  }
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  return file
}

export async function ensurePersonas(
  runtime: SystemRuntime = new SystemRuntime(),
  rng: () => number = Math.random,
): Promise<Record<CrewRole, string>> {
  const file = personasFilePath(runtime)
  if (existsSync(file)) {
    return loadPersonas(runtime)
  }
  const fresh = generateRandomPersonas(undefined, rng)
  await savePersonas(fresh, runtime)
  return fresh
}

export async function rerollPersonas(
  targetRole?: CrewRole,
  runtime: SystemRuntime = new SystemRuntime(),
  rng: () => number = Math.random,
): Promise<{ personas: Record<CrewRole, string>; file: string }> {
  const current = await loadPersonas(runtime)
  let next: Record<CrewRole, string>

  if (targetRole) {
    const used = new Set(Object.values(current))
    const picked = pickRandomNames(1, used, rng)[0] ?? DEFAULT_PERSONAS[targetRole]
    next = { ...current, [targetRole]: picked }
  } else {
    next = generateRandomPersonas(current, rng)
  }

  const file = await savePersonas(next, runtime)
  return { personas: next, file }
}

export function renderPersonaLine(role: CrewRole, name: string): string {
  const meta = ROLE_META[role]
  return `Tu identidad asignada en la tripulación es **${name}** (${meta.icon} \`[${name} · ${role}]\`). Inicia siempre la primera línea de tu entrega con tu insignia: \`${meta.icon} [${name} · ${role}]\`.`
}
