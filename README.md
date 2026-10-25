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
crewseb setup                                                 # Registra en hubseb e instala en los agentes detectados
crewseb roster                                                # Muestra los 10 especialistas y sus nombres aleatorios actuales
crewseb reroll                                                # Sortea nuevos nombres para toda la tripulación y sincroniza
crewseb reroll developer                                      # Sortea un nuevo nombre solo para el developer
crewseb models                                                # Muestra los modelos activos por especialista y host
crewseb models preset ollama                                  # Configura subagentes locales con Ollama por tier
crewseb models preset cloud-tiered                            # Asigna modelos escalonados por tier en la nube
crewseb models set <rol> <modelo> [--host <host>]             # Fija un modelo para un rol (global o por host)
crewseb models set-tier <fast|balanced|deep> <modelo> [--host <host>] # Fija el modelo de un tier de razonamiento
crewseb models reset [rol] [--host <host>]                    # Restaura la configuración de modelos por defecto
crewseb budget                                                # Verifica el costo de tokens/caracteres de toda la tripulación
crewseb check                                                 # Verifica si el bloque de reglas de cada agente está al día
crewseb uninstall                                             # Quita subagentes, reglas, plugin y registro en hubseb
```

## La Tripulación (10 Roles)

| Icono | Rol | Tier Base | Qué hace | Herramientas |
|---|---|---|---|---|
| 🔍 | `researcher` | `balanced` | Verifica supuestos cruzando mínimo 2 fuentes antes de planear | lectura, Bash, web |
| 📋 | `analyst` | `balanced` | Historias de usuario, alcance y criterios Given/When/Then | lectura, Bash |
| 🏛️ | `architect` | `deep` | Diseño de soluciones, comparación de alternativas y diagramas Mermaid/ADR | lectura, Bash, web |
| 🛠️ | `developer` | `deep` | Implementa features o bugfixes acotados en su worktree con pruebas y gate | todas |
| 🧪 | `qa-automation` | `balanced` | Matriz de pruebas y tests unitarios, integración y e2e (Playwright) | todas |
| 🚀 | `devops` | `balanced` | Terraform por manifests, OIDC, GitLab CI y GitHub Actions | todas |
| 📡 | `sre` | `balanced` | Incidentes, logs, métricas, causa raíz y runbooks | lectura, Bash, web |
| 🛡️ | `security` | `deep` | Auditoría de IAM, red, secretos, código y dependencias con escenario real | lectura, Bash, web |
| 👁️ | `code-reviewer` | `deep` | Revisión de diff o MR antes de mezclar (separa «bloquea» de «sugerencia») | lectura, Bash |
| 📚 | `documenter` | `balanced` | README, documentación técnica y runbooks verificados contra el código | lectura, escritura, Bash |

## Modelos Personalizados y Subagentes Locales (Ollama)

`crewseb` guarda tu configuración de modelos en `~/.config/seb/crewseb-models.json` (o `CREWSEB_MODELS_FILE`) y recompila/redespliega automáticamente los 10 especialistas en todos los hosts detectados al ejecutar cualquier subcomando `crewseb models`.

### Jerarquía Híbrida de Resolución

Para cada especialista y cada host (`opencode`, `codex`, `claude`, `antigravity`), el modelo se resuelve en este orden de prioridad:

1. **Override por `rol + host`** (`overrides[rol][host]`)
2. **Override por `rol global`** (`overrides[rol]['*']`)
3. **Modelo del `tier` (`fast | balanced | deep`) en el host** (`tiers[host][tier]`)
4. **Default del driver del host** (`sonnet`/`opus` en Claude Code; `inherit` en Antigravity, Codex y OpenCode)

### Ejemplos Prácticos

```sh
# 1. Activar Ollama local por tier (fast=qwen2.5-coder:7b, balanced=qwen2.5-coder:14b, deep=deepseek-r1:32b)
crewseb models preset ollama

# 2. Activar Ollama con un único modelo local para todos los tiers
crewseb models preset ollama --model ollama/qwen2.5-coder:32b

# 3. Personalizar los 3 tiers de Ollama individualmente
crewseb models preset ollama \
  --fast ollama/qwen2.5-coder:7b \
  --balanced ollama/qwen2.5-coder:14b \
  --deep ollama/deepseek-r1:32b

# 4. Asignar modelos escalonados en la nube (flash_lite/flash/pro, haiku/sonnet/opus, o4-mini/gpt-5.4/o3)
crewseb models preset cloud-tiered

# 5. Personalizar un rol específico por host
crewseb models set developer ollama/qwen2.5-coder:32b --host opencode
crewseb models set architect pro --host antigravity

# 6. Cambiar un tier completo y ver la matriz resultante
crewseb models set-tier deep ollama/deepseek-r1:32b --host codex
crewseb models

# 7. Volver a los valores por defecto
crewseb models reset
```

### Compilación de Modelos por Host

| Host | Formato nativo generado | Notas |
|---|---|---|
| **OpenCode** | `model: <provider>/<model>` | Ej. `model: ollama/qwen2.5-coder:32b` o `model: anthropic/claude-sonnet-4-5` en el frontmatter Markdown |
| **Codex** | `model` + `model_provider` | Si usas `<provider>/<model>` (ej. `ollama/deepseek-r1:32b`), separa `model = "deepseek-r1:32b"` y `model_provider = "ollama"` en el `.toml` |
| **Claude Code** | `model: <model>` | Ej. `haiku`, `sonnet`, `opus` o ID de modelo compatible con tu proxy/gateway en el frontmatter |
| **Antigravity (`agy`)** | `model: inherit \| flash_lite \| flash \| pro` | Si recibe un modelo externo incompatible con su enum nativo, hace fallback seguro a `inherit` |
