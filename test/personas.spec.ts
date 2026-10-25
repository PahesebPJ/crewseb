import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { SystemRuntime } from 'hubseb'
import {
  CREW_ROLES,
  ensurePersonas,
  rerollPersonas,
} from '../src/personas.ts'

describe('crewseb random persona engine', () => {
  it('assigns 10 unique random names and supports full or single-role reroll', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'crewseb-personas-'))
    try {
      const personasFile = path.join(tmpDir, 'personas.json')
      const runtime = new SystemRuntime({
        homeDir: tmpDir,
        env: { ...process.env, CREWSEB_PERSONAS_FILE: personasFile },
      })

      const initial = await ensurePersonas(runtime)
      const uniqueInitial = new Set(Object.values(initial))
      assert.equal(uniqueInitial.size, CREW_ROLES.length, 'all 10 roles must have unique names')

      // Reroll only developer
      const prevDev = initial.developer
      const prevArch = initial.architect
      const single = await rerollPersonas('developer', runtime)
      assert.notEqual(single.personas.developer, prevDev, 'developer should receive a new name')
      assert.equal(single.personas.architect, prevArch, 'other roles must remain untouched')
      assert.equal(new Set(Object.values(single.personas)).size, CREW_ROLES.length)

      // Reroll entire crew
      const full = await rerollPersonas(undefined, runtime)
      assert.equal(new Set(Object.values(full.personas)).size, CREW_ROLES.length)
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  })
})
