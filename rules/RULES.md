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
- Todo plan de implementación debe finalizar con una **Matriz de Despacho** indicando: Paso, Especialista de `crewseb` (`researcher`, `analyst`, `architect`, `developer`, `qa-automation`, `devops`, `sre`, `security`, `code-reviewer`, `documenter`), Objetivo, Dependencias y Archivos afectados.
- Las particiones que no compartan archivos ni dependan entre sí deben lanzarse **en paralelo**.
- Antes de dar por concluida cualquier implementación de código o infraestructura, el cambio debe ser validado por `qa-automation` y `code-reviewer` (y por `security` cuando involucre permisos, red, autenticación o secretos).
