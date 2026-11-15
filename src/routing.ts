import type { HostId } from 'hubseb'
import { type CrewModelsConfig, resolveRole } from './models.ts'
import { CREW_ROLES } from './personas.ts'

const HOST_LABEL: Record<HostId, string> = {
  antigravity: 'Antigravity (agy)',
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

/**
 * Appends a per-host routing section to the global directives: for every orchestrator host it
 * lists the roles that run elsewhere and tells it to delegate through sebshell's `seb_delegate`
 * MCP tool instead of its native subagent mechanism. Returns the input untouched without routing.
 */
export function renderRoutingDirectives(base: string, config?: CrewModelsConfig): string {
  const routing = config?.routing ?? {}
  const routed = CREW_ROLES.filter((r) => routing[r])
  if (routed.length === 0) return base

  const blocks: string[] = []
  for (const orchestrator of ['claude', 'antigravity'] as const) {
    const remote = routed.filter((r) => routing[r] !== orchestrator)
    if (remote.length === 0) continue
    const rows = remote.map((role) => {
      const target = routing[role] as HostId
      const h = resolveRole(role, config).hosts[target]
      return `| \`${role}\` | ${HOST_LABEL[target]} | \`${h.model}\` | ${h.effort ?? 'por defecto'} |`
    })
    blocks.push(
      [
        `::: agent ${orchestrator}`,
        '## Ruteo de Subagentes entre Hosts (`sebshell`)',
        'Estos roles se ejecutan en otro host. **No** los lances con tu mecanismo nativo de subagentes: delega con la herramienta MCP `seb_delegate` pasando `{ agent, prompt }` (sebshell aplica host, modelo y esfuerzo configurados y devuelve el handoff del especialista). Si `seb_delegate` no está disponible, usa el subagente nativo e indícalo en el handoff.',
        '',
        '| Rol | Host | Modelo | Esfuerzo |',
        '|---|---|---|---|',
        ...rows,
        ':::',
      ].join('\n'),
    )
  }
  return blocks.length === 0 ? base : `${base.trimEnd()}\n\n${blocks.join('\n\n')}\n`
}
