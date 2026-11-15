import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { decodeWire, SystemRuntime } from 'hubseb'
import { executeCrewCli } from '../src/bin/crewseb.ts'
import { buildAgents } from '../src/build.ts'
import { catalogCacheFile, checkModel, loadCatalog, parseAgyModels, splitEffortSuffix } from '../src/catalog.ts'
import {
  buildPresetConfig,
  loadModelsConfig,
  normalizeRoleExtras,
  resetModelsConfig,
  resolveRole,
  setRoleEffort,
  setRoleRouting,
  setTierModel,
} from '../src/models.ts'
import { DEFAULT_PERSONAS } from '../src/personas.ts'
import { renderRoutingDirectives } from '../src/routing.ts'
import { auditCrewsebDirectives } from '../src/setup.ts'

// Captured from `agy models` on 2026-11-14.
const AGY_MODELS_OUTPUT = `Fetching available models...
gemini-4-argon-medium\tGemini 4 Argon (Medium)
gemini-4-argon-high\tGemini 4 Argon (High)
gemini-4-argon-low\tGemini 4 Argon (Low)
gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)
gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)
gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)
gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)
gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
claude-opus-5-5-high\tClaude Opus 5.5 (High)
`

let tmp: string
let runtime: SystemRuntime

const cli = async (...args: string[]) => executeCrewCli([...args, '--json'], runtime)
const payload = <T>(stdout: string): T => {
  const packet = decodeWire<T>(stdout)
  assert.equal(packet.status, 'success', stdout)
  return (packet as { payload: T }).payload
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'crewseb-effort-'))
  // Simulate a machine with both hosts installed: crewseb detects a host by its config root,
  // and CI runners have neither claude nor agy on PATH.
  await mkdir(path.join(tmp, '.claude'), { recursive: true })
  await mkdir(path.join(tmp, '.gemini', 'config'), { recursive: true })
  runtime = new SystemRuntime({
    homeDir: tmp,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(tmp, '.config'),
      HUBSEB_HOME: path.join(tmp, '.hubseb'),
      CREWSEB_MODELS_FILE: path.join(tmp, 'crewseb-models.json'),
      CREWSEB_PERSONAS_FILE: path.join(tmp, 'personas.json'),
    },
  })
  // Pre-seed a fresh catalog cache so no test ever spawns the real `agy`.
  const file = catalogCacheFile(runtime, 'antigravity')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(
    file,
    JSON.stringify({ host: 'antigravity', source: 'live', fetchedAt: new Date().toISOString(), models: parseAgyModels(AGY_MODELS_OUTPUT) }),
  )
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('model catalog', () => {
  it('groups agy effort variants by base id, so Gemini 4 Hydrogen appears with all its efforts', () => {
    const models = parseAgyModels(AGY_MODELS_OUTPUT)
    const hydrogen = models.find((m) => m.id === 'gemini-4-hydrogen')
    assert.deepEqual(hydrogen, { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'] })
    assert.deepEqual(models.find((m) => m.id.startsWith('gemini-pro-orchestrator')), { id: 'gemini-pro-orchestrator-g1-pro', label: 'Orchestrator (Argon)', efforts: [] })
    assert.ok(!models.some((m) => m.id.startsWith('Fetching')))
  })

  it('splits effort suffixes only for known levels', () => {
    assert.deepEqual(splitEffortSuffix('gemini-4-hydrogen-xhigh'), { base: 'gemini-4-hydrogen', effort: 'xhigh' })
    assert.deepEqual(splitEffortSuffix('gemini-pro-orchestrator-g1-pro'), { base: 'gemini-pro-orchestrator-g1-pro', effort: null })
  })

  it('uses the cache, refreshes when asked and falls back when agy is unavailable', async () => {
    const cached = await loadCatalog('antigravity', runtime, { fetchAgy: async () => assert.fail('must use cache') })
    assert.equal(cached.source, 'cache')
    assert.ok(cached.models.some((m) => m.id === 'pro' && m.nativeTier))
    const live = await loadCatalog('antigravity', runtime, { refresh: true, fetchAgy: async () => 'gemini-9-new-high\tGemini 9 New (High)\n' })
    assert.deepEqual(live.models.filter((m) => !m.nativeTier).map((m) => m.id), ['gemini-9-new'])
    const offline = await loadCatalog('antigravity', runtime, { refresh: true, fetchAgy: async () => null })
    assert.equal(offline.source, 'cache', 'stale cache beats nothing')
  })

  it('soft-validates models and efforts', async () => {
    const agy = await loadCatalog('antigravity', runtime)
    assert.equal(checkModel(agy, 'gemini-4-hydrogen', 'xhigh').warning, null)
    assert.match(checkModel(agy, 'gemini-4-hydrogen', 'max').warning ?? '', /no ofrece esfuerzo max/)
    assert.match(checkModel(agy, 'gemini-4-hydrogen-high', 'low').warning ?? '', /ya fija el esfuerzo high/)
    assert.match(checkModel(agy, 'pro', 'high').warning ?? '', /no admite esfuerzo/)
    assert.match(checkModel(agy, 'gemini-x', null).warning ?? '', /no está en el catálogo/)
  })
})

describe('per-role effort, agy tier and routing', () => {
  it('sets Hydrogen xhigh for developer on agy: native frontmatter gets the tier, sebshell gets the concrete model', async () => {
    const res = await cli('models', 'set', 'developer', 'gemini-4-hydrogen', '--host', 'antigravity', '--effort', 'xhigh', '--tier', 'pro')
    const out = payload<{ warnings: string[] }>(res.stdout)
    assert.ok(out.warnings.some((w) => /se aplica cuando sebshell invoca/.test(w)))

    const agent = await readFile(path.join(tmp, '.gemini', 'config', 'plugins', 'crewseb', 'agents', 'developer.md'), 'utf8')
    assert.match(agent, /^model: pro$/m, 'agy never receives a concrete id (its loader would skip the agent)')

    const { roles } = payload<{ roles: ReturnType<typeof resolveRole>[] }>((await cli('models', 'resolve', 'developer')).stdout)
    assert.deepEqual(roles[0]?.hosts.antigravity, { model: 'gemini-4-hydrogen', native: 'pro', effort: 'xhigh', appliedAt: 'invocation' })
  })

  it('writes a custom Claude effort and model into the native agent', async () => {
    await cli('models', 'set', 'code-reviewer', 'claude-opus-5-5', '--host', 'claude', '--effort', 'max')
    const agent = await readFile(path.join(tmp, '.claude', 'agents', 'code-reviewer.md'), 'utf8')
    assert.match(agent, /^model: claude-opus-5-5$/m)
    assert.match(agent, /^effort: max$/m)
    await cli('models', 'effort', 'code-reviewer', 'none', '--host', 'claude')
    const reset = await readFile(path.join(tmp, '.claude', 'agents', 'code-reviewer.md'), 'utf8')
    assert.match(reset, /^effort: high$/m, 'back to the deep-tier default')
  })

  it('rejects invalid efforts, tiers and tier without agy host', async () => {
    assert.equal((await cli('models', 'set', 'developer', 'opus', '--effort', 'turbo')).exitCode, 2)
    assert.equal((await cli('models', 'set', 'developer', 'opus', '--host', 'antigravity', '--tier', 'ultra')).exitCode, 2)
    assert.equal((await cli('models', 'set', 'developer', 'opus', '--host', 'claude', '--tier', 'pro')).exitCode, 2)
    assert.equal((await cli('models', 'route', 'developer', 'mars')).exitCode, 2)
    assert.equal((await cli('models', 'route', 'developer', 'codex')).exitCode, 2, 'sebshell cannot delegate to codex')
  })

  it('routes roles: Claude directives tell the orchestrator to use seb_delegate, and the audit stays verified', async () => {
    await cli('models', 'set', 'developer', 'gemini-4-hydrogen', '--host', 'antigravity', '--effort', 'xhigh')
    await cli('models', 'route', 'developer', 'agy')
    const claudeMd = await readFile(path.join(tmp, '.claude', 'CLAUDE.md'), 'utf8')
    assert.match(claudeMd, /seb_delegate/)
    assert.match(claudeMd, /\| `developer` \| Antigravity \(agy\) \| `gemini-4-hydrogen` \| xhigh \|/)
    const geminiMd = await readFile(path.join(tmp, '.gemini', 'GEMINI.md'), 'utf8')
    assert.doesNotMatch(geminiMd, /Ruteo de Subagentes/, 'agy runs developer itself, nothing to delegate')
    const audit = await auditCrewsebDirectives({ runtime, hosts: ['claude', 'antigravity'] })
    assert.ok(audit.every((a) => a.status === 'verified'), JSON.stringify(audit))

    await cli('models', 'route', 'developer', 'none')
    assert.doesNotMatch(await readFile(path.join(tmp, '.claude', 'CLAUDE.md'), 'utf8'), /seb_delegate/)
  })

  it('keeps efforts and routing across set-tier and role resets', async () => {
    await setRoleEffort('architect', 'high', 'claude', runtime)
    await setRoleRouting('researcher', 'antigravity', runtime)
    await setTierModel('balanced', 'sonnet', 'claude', runtime)
    let config = await loadModelsConfig(runtime)
    assert.equal(config.efforts?.architect?.claude, 'high')
    assert.equal(config.routing?.researcher, 'antigravity')
    await resetModelsConfig('architect', undefined, runtime)
    config = await loadModelsConfig(runtime)
    assert.equal(config.efforts?.architect, undefined)
    assert.equal(config.routing?.researcher, 'antigravity', 'routing survives a model reset')
  })

  it('clearing one host effort does not inherit the wildcard, and presets keep routing/efforts', async () => {
    await setRoleEffort('developer', 'high', '*', runtime)
    await setRoleEffort('developer', null, 'claude', runtime)
    const r = resolveRole('developer', await loadModelsConfig(runtime))
    assert.deepEqual([r.hosts.claude.effort, r.hosts.antigravity.effort], [null, 'high'])
    await setRoleRouting('developer', 'antigravity', runtime)
    await cli('models', 'preset', 'lite')
    const after = await loadModelsConfig(runtime)
    assert.equal(after.preset, 'lite')
    assert.equal(after.routing?.developer, 'antigravity')
    assert.equal(after.efforts?.developer?.antigravity, 'high')
  })

  it('accepts --effort none on set', async () => {
    await cli('models', 'set', 'sre', 'sonnet', '--host', 'claude', '--effort', 'high')
    await cli('models', 'set', 'sre', 'sonnet', '--host', 'claude', '--effort', 'none')
    assert.equal(resolveRole('sre', await loadModelsConfig(runtime)).hosts.claude.effort, null)
  })

  it('drops invalid hand-edited entries', () => {
    const extras = normalizeRoleExtras({
      efforts: { developer: { claude: 'max', antigravity: 'turbo' }, ghost: { claude: 'low' } } as never,
      agyTiers: { developer: 'pro', sre: 'gemini-4-hydrogen' } as never,
      routing: { developer: 'antigravity', sre: 'mars' } as never,
    })
    assert.deepEqual(extras, { efforts: { developer: { claude: 'max' } }, agyTiers: { developer: 'pro' }, routing: { developer: 'antigravity' } })
  })

  it('builds byte-identical agents when no effort/tier/routing is configured (regression)', async () => {
    const base = buildPresetConfig('default')
    const withEmpty = { ...base, efforts: {}, agyTiers: {}, routing: {} }
    const a = await buildAgents(DEFAULT_PERSONAS, undefined, undefined, base)
    const b = await buildAgents(DEFAULT_PERSONAS, undefined, undefined, withEmpty)
    assert.deepEqual(b, a)
    assert.equal(renderRoutingDirectives('# rules\n', withEmpty), '# rules\n')
  })
})
