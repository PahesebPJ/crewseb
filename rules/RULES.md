# Directivas Globales de Ingeniería (`crewseb`)

## 1. Control de Versiones y Limpieza de Historial
- Formato de mensajes de commit: Conventional Commits en inglés (`<type>(<scope>): <imperative summary>`, ej. `feat(auth): add token rotation`).
- Higiene de autoría:
::: agent claude
  - No incluyas firmas automáticas de IA (`Co-Authored-By`, menciones a Claude o Anthropic) en commits, ramas ni PR/MR.
:::
::: agent codex
  - No incluyas firmas automáticas de IA (`Co-Authored-By`, menciones a Codex u OpenAI) en commits, ramas ni PR/MR.
:::
::: agent gemini antigravity
  - No incluyas firmas automáticas de IA (`Co-Authored-By`, menciones a Antigravity, Gemini o Google) en commits, ramas ni PR/MR.
:::
::: agent opencode
  - No incluyas firmas automáticas de IA (`Co-Authored-By`, menciones a OpenCode o al modelo) en commits, ramas ni PR/MR.
:::

## 2. Estrategia de Ramas y Aislamiento por Sandbox (Worktrees)
- Toda tarea que altere archivos debe ejecutarse en una rama dedicada (`feature/<slug>`, `bugfix/<slug>`, `hotfix/<version>`) dentro de su propio worktree aislado para no contaminar la copia de trabajo principal.
::: agent claude
- En Claude Code utiliza `EnterWorktree` tras actualizar la rama base.
:::
::: agent !claude
- Aprovisiona el entorno con `git worktree add -b <rama> .worktrees/<slug> origin/<base>` (o en Antigravity delegando con `Workspace: "branch"`).
:::
- Asegúrate de enlazar o instalar dependencias locales (`node_modules`, `.env`) dentro del worktree antes de correr pruebas.

## 3. Estándares de Código y Comunicación
- El código fuente (identificadores, tipos, archivos, tests y logs) se escribe en **inglés**; la comunicación con el usuario y la documentación solicitada en español se redactan en **español**.
- Evita comentarios redundantes que expliquen qué hace una línea obvia; documenta únicamente decisiones de diseño no triviales o pendientes explícitos (`TODO:` / `FIXME:`).
- **Principio de Evidencia Empírica:** Ninguna tarea se reporta como completada sin haber ejecutado y mostrado la salida de sus comandos de verificación (`typecheck`, `test`, `build`, `validate`).

## 4. Protocolo de Orquestación y Delegación (`crewseb`)
- **Gate de Rentabilidad (Economía de Tokens y Fast-Path):**
  - **Ruta Rápida (Ejecución Directa):** Si la tarea es atómica, puntual ($\le 2$ archivos afectados), corrección de bugs evidentes, consultas o cambios cosméticos, resuélvela tú mismo en el turno principal sin generar un plan formal multi-paso ni instanciar subagentes.
  - **Override Explícito del Usuario:** Si el usuario solicita explícitamente armar un plan o usar subagentes (ej. *«arma un plan con subagentes»*, *«usa crewseb»*), omite la Ruta Rápida y ejecuta el plan con la tripulación.
  - **Ruta Orquestada (Tripulación `crewseb`):** Para features, refactorizaciones estructurales, incidentes complejos o cambios multi-módulo, formaliza un plan cerrado con una **Matriz de Despacho** indicando: Paso, Especialista de `crewseb` (`researcher`, `analyst`, `architect`, `developer`, `qa-automation`, `devops`, `sre`, `security`, `code-reviewer`, `documenter`), Objetivo, Dependencias y Archivos afectados.
- **Particionado Concurrente:** Las particiones que no compartan archivos ni dependan entre sí deben lanzarse **en paralelo**.
- **Límite de Turnos y Decisión de Handoff:** Cada subagente opera con cuota acotada de pasos (`maxSteps`). Si un subagente devuelve `[CHECKPOINT - LÍMITE DE TURNOS]`, el orquestador evalúa el remanente reportado:
  - Si es pequeño o atómico, el propio orquestador lo concluye directamente en la rama para ahorrar tokens.
  - Si es sustancial o complejo, despacha a un nuevo subagente de relevo con el contexto del checkpoint.
- **Validación de Cierre:** En la Ruta Orquestada, antes de dar por concluida cualquier implementación de código o infraestructura, el cambio debe ser validado por `qa-automation` y `code-reviewer` (y por `security` cuando involucre permisos, red, autenticación o secretos). En la Ruta Rápida, el agente ejecuta y muestra la prueba empírica directamente.
