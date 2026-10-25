# crewseb

Una tripulación de **10 subagentes especialistas** con **nombres propios aleatorios**, reglas de ingeniería compartidas y delegación automática para **Antigravity CLI (`agy`)**, **Claude Code**, **Codex** y **OpenCode**.

Se conecta y registra automáticamente en [**hubseb**](../hubseb).

## Qué incluye

- **10 Subagentes Especialistas** (`researcher`, `analyst`, `architect`, `developer`, `qa-automation`, `devops`, `sre`, `security`, `code-reviewer`, `documenter`).
- **Motor de Identidades Aleatorias (`Persona Engine`)**: Cada subagente tiene su rol técnico fijo, pero recibe un **nombre propio aleatorio** único (ej. `🛠️ [Kael · developer]`, `🔍 [Lyra · researcher]`). Puedes ver tu tripulación actual con `crewseb roster` o sortear nuevos nombres con `crewseb reroll`.
- **6 Convenciones Modulares (`@include`)**: `handoff` (entrega máxima de 15 líneas), `branch` (worktrees aislados), `stack-node`, `stack-terraform`, `ci` y `observability`.
- **Reglas Globales (`rules/RULES.md`)**: Se inyectan una sola vez entre `<!-- hubseb:crewseb:begin -->` y `<!-- hubseb:crewseb:end -->` en la memoria global de cada agente.
- **Orquestador `/crewseb`**: Encadena automáticamente a la tripulación según el tipo de tarea (Feature, Bug, Infraestructura, Incidente o Revisión).

## Instalación (Para Humanos o Agentes de IA)

```sh
npm install
npm run build
crewseb setup
```

`crewseb setup` registra `crewseb` en `hubseb` (`~/.config/seb/tools.d/crewseb.json`), sortea o carga los nombres de tu tripulación y los instala en los agentes que encuentre en tu máquina (`--agents claude,antigravity` elige cuáles, `--agents all` fuerza los 4).

## Comandos CLI

```sh
crewseb setup                      # Registra en hubseb e instala en los agentes detectados
crewseb roster                     # Muestra los 10 especialistas y sus nombres aleatorios actuales
crewseb reroll                     # Sortea nuevos nombres para toda la tripulación y sincroniza
crewseb reroll developer           # Sortea un nuevo nombre solo para el developer
crewseb budget                     # Verifica el costo de tokens/caracteres de toda la tripulación
crewseb check                      # Verifica si el bloque de reglas de cada agente está al día
crewseb uninstall                  # Quita subagentes, reglas, plugin y registro en hubseb
```

## La Tripulación (10 Roles)

| Icono | Rol | Qué hace | Herramientas |
|---|---|---|---|
| 🔍 | `researcher` | Verifica supuestos cruzando mínimo 2 fuentes antes de planear | lectura, Bash, web |
| 📋 | `analyst` | Historias de usuario, alcance y criterios Given/When/Then | lectura, Bash |
| 🏛️ | `architect` | Diseño de soluciones, comparación de alternativas y diagramas Mermaid/ADR | lectura, Bash, web |
| 🛠️ | `developer` | Implementa features o bugfixes acotados en su worktree con pruebas y gate | todas |
| 🧪 | `qa-automation` | Matriz de pruebas y tests unitarios, integración y e2e (Playwright) | todas |
| 🚀 | `devops` | Terraform por manifests, OIDC, GitLab CI y GitHub Actions | todas |
| 📡 | `sre` | Incidentes, logs, métricas, causa raíz y runbooks | lectura, Bash, web |
| 🛡️ | `security` | Auditoría de IAM, red, secretos, código y dependencias con escenario real | lectura, Bash, web |
| 👁️ | `code-reviewer` | Revisión de diff o MR antes de mezclar (separa «bloquea» de «sugerencia») | lectura, Bash |
| 📚 | `documenter` | README, documentación técnica y runbooks verificados contra el código | lectura, escritura, Bash |
