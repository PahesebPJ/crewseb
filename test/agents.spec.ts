import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  analyzeBudget,
  buildAgents,
  CREW_ROLES,
  RULES_FILE,
  TARGET_AGENTS,
  TARGETS_DIR,
  writeAgents,
} from '../src/build.ts'
import { DEFAULT_PERSONAS } from '../src/personas.ts'

describe('crewseb subagents, protocols, 4-target compilation & context budget', () => {
  it('builds all 10 specialist subagents with {{protocol:...}} and {{persona:badge}} and generates all 4 agent targets', async () => {
    const built = await buildAgents(DEFAULT_PERSONAS)
    assert.equal(built.length, 10)
    await writeAgents(built)

    const names = built.map((b) => b.name).sort()
    assert.deepEqual(names, [...CREW_ROLES].sort())

    for (const agent of built) {
      const expectedName = DEFAULT_PERSONAS[agent.name]
      assert.match(
        agent.content,
        new RegExp(`\\[${expectedName} · ${agent.name}\\]`),
        `${agent.name} should include its persona signature`,
      )
      assert.match(
        agent.content,
        /## Contrato de Despacho/,
        `${agent.name} should include dispatch-contract protocol`,
      )
      assert.doesNotMatch(
        agent.content,
        /\{\{protocol:/,
        `${agent.name} should have no unresolved {{protocol:...}} token`,
      )
      assert.doesNotMatch(
        agent.content,
        /\{\{persona:badge\}\}/,
        `${agent.name} should have no unresolved {{persona:badge}} token`,
      )
    }

    // Verify all 4 target directories were generated (antigravity, claude, codex, opencode)
    for (const target of TARGET_AGENTS) {
      const ext = target === 'codex' ? '.toml' : '.md'
      for (const role of CREW_ROLES) {
        const file = path.join(TARGETS_DIR, target, `${role}${ext}`)
        assert.ok(existsSync(file), `missing compiled target file: ${file}`)
      }
    }
  })

  it('respects strict character and line budgets across all 10 subagents and RULES.md', async () => {
    const report = await analyzeBudget(DEFAULT_PERSONAS)
    for (const entry of report.agents) {
      assert.ok(
        entry.descriptionChars <= 300,
        `${entry.role} description is ${entry.descriptionChars} chars (max 300)`,
      )
      assert.ok(
        entry.bodyLines <= 80,
        `${entry.role} body is ${entry.bodyLines} lines (max 80)`,
      )
    }
    assert.ok(
      report.totalDescriptionChars <= 2500,
      `total descriptions ${report.totalDescriptionChars} > 2500`,
    )
    assert.ok(
      report.rulesChars <= 5200,
      `rules chars ${report.rulesChars} > 5200`,
    )
    assert.equal(report.withinBudget, true)
  })

  it('names all 10 subagents in the Delegation section of RULES.md', async () => {
    const rules = await readFile(RULES_FILE, 'utf8')
    for (const role of CREW_ROLES) {
      assert.match(rules, new RegExp(`\`${role}\``), `RULES.md should mention ${role}`)
    }
  })
})
