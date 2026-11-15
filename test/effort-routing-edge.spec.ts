import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { decodeWire, SystemRuntime } from 'hubseb'
import { executeCrewCli } from '../src/bin/crewseb.ts'
import { catalogCacheFile, checkModel, loadCatalog, type ModelCatalog, parseAgyModels } from '../src/catalog.ts'
import { buildPresetConfig, type CrewModelsConfig, loadModelsConfig, normalizeRoleExtras, resolveRole } from '../src/models.ts'
import { CREW_ROLES } from '../src/personas.ts'
import { renderRoutingDirectives } from '../src/routing.ts'

let tmp: string
let runtime: SystemRuntime

const cli = async (...args: string[]) => executeCrewCli([...args, '--json'], runtime)

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'crewseb-edge-'))
  // Simulate a machine with both hosts installed: crewseb detects a host by its config root,
  // and CI runners have neither claude nor agy on PATH.
  await mkdir(path.join(tmp, '.claude'), { recursive: true })
  await mkdir(path.join(tmp, '.gemini', 'config'), { recursive: true })
  runtime = new SystemRuntime({
    homeDir: tmp,
    env: {
      ...process.env,
      HOME: tmp,
      XDG_CONFIG_HOME: path.join(tmp, '.config'),
      HUBSEB_HOME: path.join(tmp, '.hubseb'),
      CREWSEB_MODELS_FILE: path.join(tmp, 'crewseb-models.json'),
      CREWSEB_PERSONAS_FILE: path.join(tmp, 'personas.json'),
    },
  })
  const file = catalogCacheFile(runtime, 'antigravity')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ host: 'antigravity', source: 'live', fetchedAt: new Date().toISOString(), models: [] }))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const emptyCatalog = (host: ModelCatalog['host'] = 'antigravity'): ModelCatalog => ({ host, source: 'builtin', fetchedAt: null, models: [] })

describe('catalog edge cases', () => {
  it('parses lines without a tab using the base id as label', () => {
    assert.deepEqual(parseAgyModels('gemini-x-high\n'), [{ id: 'gemini-x', label: 'gemini-x', efforts: ['high'] }])
  })

  it('skips uppercase ids, blank lines, prose and handles CRLF', () => {
    const out = parseAgyModels('Gemini-4-High\tUpper\r\n\r\n   \r\nhello world\tprose\r\ngemini-a-low\tGemini A (Low)\r\n')
    assert.deepEqual(out, [{ id: 'gemini-a', label: 'Gemini A', efforts: ['low'] }])
  })

  it('returns an empty list for empty output', () => {
    assert.deepEqual(parseAgyModels(''), [])
    assert.deepEqual(parseAgyModels('\n\n'), [])
  })

  it('does not duplicate efforts when the same variant repeats', () => {
    const out = parseAgyModels('m-high\tM (High)\nm-high\tM (High)\nm-low\tM (Low)\n')
    assert.deepEqual(out[0]?.efforts, ['low', 'high'])
  })

  it('falls back to the tiers alone when the cache is corrupt and agy is unavailable', async () => {
    await writeFile(catalogCacheFile(runtime, 'antigravity'), '{not json')
    const cat = await loadCatalog('antigravity', runtime, { fetchAgy: async () => null })
    assert.equal(cat.source, 'builtin')
    assert.ok(cat.models.length > 0 && cat.models.every((m) => m.nativeTier))
  })

  it('ignores a cache with the wrong shape and refetches', async () => {
    await writeFile(catalogCacheFile(runtime, 'antigravity'), JSON.stringify({ models: 'nope', fetchedAt: 42 }))
    const cat = await loadCatalog('antigravity', runtime, { fetchAgy: async () => 'm-high\tM (High)\n' })
    assert.equal(cat.source, 'live')
    assert.ok(cat.models.some((m) => m.id === 'm'))
  })

  it('treats an unparseable fetchedAt as stale instead of fresh', async () => {
    await writeFile(catalogCacheFile(runtime, 'antigravity'), JSON.stringify({ host: 'antigravity', fetchedAt: 'garbage', models: [] }))
    let calls = 0
    await loadCatalog('antigravity', runtime, { fetchAgy: async () => (calls++, 'm-high\tM (High)\n') })
    assert.equal(calls, 1)
  })

  it('does not persist or use an empty agy output as live', async () => {
    const cat = await loadCatalog('antigravity', runtime, { refresh: true, fetchAgy: async () => '' })
    assert.notEqual(cat.source, 'live')
  })

  it('checkModel with an empty catalog never warns', () => {
    for (const effort of [null, undefined, 'max' as const]) {
      assert.deepEqual(checkModel(emptyCatalog(), 'anything-high', effort), { known: false, effortSupported: true, warning: null })
    }
  })

  it('returns an empty builtin catalog for hosts without model discovery', async () => {
    const cat = await loadCatalog('codex', runtime)
    assert.deepEqual(cat.models, [])
  })
})

describe('config normalization and resolution edge cases', () => {
  it('normalizeRoleExtras survives garbage types', () => {
    const garbage = [null, undefined, 0, 'str', true, [], [1, 2], {}, () => 1]
    for (const g of garbage) {
      assert.doesNotThrow(() => normalizeRoleExtras({ efforts: g, agyTiers: g, routing: g } as never))
    }
    assert.deepEqual(normalizeRoleExtras({ efforts: 'x', agyTiers: 1, routing: [] } as never), {})
    assert.deepEqual(normalizeRoleExtras({ efforts: { developer: null, sre: 'high', architect: [] } } as never), {})
    assert.deepEqual(normalizeRoleExtras({ efforts: { developer: { '*': 'low', mars: 'low', claude: 5, codex: null } } } as never), { efforts: { developer: { '*': 'low' } } })
    assert.deepEqual(normalizeRoleExtras({ routing: { developer: 42, sre: null, architect: {} } } as never), {})
    assert.deepEqual(normalizeRoleExtras({ agyTiers: { developer: null, sre: {} } } as never), {})
  })

  it('does not pollute prototypes through __proto__ keys', () => {
    const raw = JSON.parse('{"routing":{"__proto__":"claude"},"efforts":{"__proto__":{"claude":"low"}}}')
    assert.deepEqual(normalizeRoleExtras(raw), {})
    assert.equal(({} as Record<string, unknown>).claude, undefined)
  })

  it('loadModelsConfig drops garbage extras from a hand-edited file', async () => {
    await writeFile(path.join(tmp, 'crewseb-models.json'), JSON.stringify({ efforts: 7, routing: { developer: 'mars' }, agyTiers: [] }))
    const config = await loadModelsConfig(runtime)
    assert.equal(config.efforts, undefined)
    assert.equal(config.routing, undefined)
    assert.equal(config.agyTiers, undefined)
  })

  it('resolveRole without any config uses defaults for every role', () => {
    for (const role of CREW_ROLES) {
      for (const config of [undefined, buildPresetConfig('default')]) {
        const r = resolveRole(role, config)
        assert.equal(r.role, role)
        assert.equal(r.runsOn, null)
        assert.ok(Object.values(r.hosts).every((h) => h.model && h.native))
        assert.equal(r.hosts.antigravity.effort, null)
      }
    }
  })

  it('resolveRole prefers a host effort over the wildcard and marks agy effort as invocation-level', () => {
    const config: CrewModelsConfig = { ...buildPresetConfig('default'), efforts: { developer: { '*': 'low', claude: 'max' } } }
    const r = resolveRole('developer', config)
    assert.equal(r.hosts.claude.effort, 'max')
    assert.equal(r.hosts.antigravity.effort, 'low')
    assert.equal(r.hosts.antigravity.appliedAt, 'invocation')
  })
})

describe('routing directives edge cases', () => {
  it('with every role routed to claude, only the antigravity orchestrator gets a block', () => {
    const routing = Object.fromEntries(CREW_ROLES.map((r) => [r, 'claude'])) as CrewModelsConfig['routing']
    const out = renderRoutingDirectives('# base\n', { ...buildPresetConfig('default'), routing })
    assert.ok(!out.includes('::: agent claude'))
    assert.equal(out.match(/::: agent antigravity/g)?.length, 1)
    for (const role of CREW_ROLES) assert.ok(out.includes(`| \`${role}\` | Claude Code |`), role)
  })

  it('with every role routed to agy, only the claude orchestrator gets a block', () => {
    const routing = Object.fromEntries(CREW_ROLES.map((r) => [r, 'antigravity'])) as CrewModelsConfig['routing']
    const out = renderRoutingDirectives('# base\n', { ...buildPresetConfig('default'), routing })
    assert.ok(!out.includes('::: agent antigravity'))
    assert.equal(out.match(/::: agent claude/g)?.length, 1)
  })

  it('a role routed to a non-orchestrator host produces no block', () => {
    const out = renderRoutingDirectives('# base\n', { ...buildPresetConfig('default'), routing: { developer: 'codex' } })
    assert.match(out, /::: agent claude/)
    assert.match(out, /Codex/)
  })

  it('returns the base untouched for undefined or empty routing', () => {
    assert.equal(renderRoutingDirectives('x'), 'x')
    assert.equal(renderRoutingDirectives('x', { ...buildPresetConfig('default'), routing: {} }), 'x')
  })
})

describe('models CLI edge cases', () => {
  it('route to the claude host adds no claude block but tells agy to delegate; none restores', async () => {
    const res = await cli('models', 'route', 'developer', 'claude')
    assert.equal(res.exitCode, 0, res.stdout + res.stderr)
    assert.equal((await loadModelsConfig(runtime)).routing?.developer, 'claude')
    assert.doesNotMatch(await readFile(path.join(tmp, '.claude', 'CLAUDE.md'), 'utf8'), /Ruteo de Subagentes/)
    assert.match(await readFile(path.join(tmp, '.gemini', 'GEMINI.md'), 'utf8'), /Ruteo de Subagentes/)
    assert.equal((await cli('models', 'route', 'developer', 'none')).exitCode, 0)
    assert.equal((await loadModelsConfig(runtime)).routing, undefined)
  })

  it('route rejects unknown roles and missing target', async () => {
    assert.equal((await cli('models', 'route', 'ghost', 'claude')).exitCode, 2)
    assert.equal((await cli('models', 'route', 'developer')).exitCode, 2)
  })

  it("set with --host '*' and --effort stores the wildcard effort and applies it to claude", async () => {
    const res = await cli('models', 'set', 'developer', 'opus', '--host', '*', '--effort', 'max')
    assert.equal(res.exitCode, 0, res.stdout + res.stderr)
    const packet = decodeWire<{ warnings: string[] }>(res.stdout)
    assert.equal(packet.status, 'success')
    const config = await loadModelsConfig(runtime)
    assert.deepEqual(config.efforts?.developer, { '*': 'max' })
    assert.equal(config.overrides.developer?.['*'], 'opus')
    const agent = await readFile(path.join(tmp, '.claude', 'agents', 'developer.md'), 'utf8')
    assert.match(agent, /^effort: max$/m)
    assert.equal(resolveRole('developer', config).hosts.antigravity.appliedAt, 'invocation')
  })

  it("set --host '*' rejects an invalid effort without touching the config", async () => {
    assert.equal((await cli('models', 'set', 'developer', 'opus', '--host', '*', '--effort', 'turbo')).exitCode, 2)
    assert.equal((await loadModelsConfig(runtime)).efforts, undefined)
  })

  it("set --host '*' with --tier is rejected (tier is agy only)", async () => {
    assert.equal((await cli('models', 'set', 'developer', 'opus', '--host', '*', '--tier', 'pro')).exitCode, 2)
  })
})
