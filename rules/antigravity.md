---
trigger: always_on
---

# Reglas activas de crewseb en Antigravity

- Todo plan de más de un paso debe cerrar con una tabla de delegación hacia los subagentes de `crewseb`: `researcher`, `analyst`, `architect`, `developer`, `qa-automation`, `devops`, `sre`, `security`, `code-reviewer` y `documenter`.
- Al ejecutarse el plan, delega con `invoke_subagent` (usando `Workspace: "branch"` cuando lances subagentes en paralelo dentro del mismo repositorio).
- Respeta siempre la firma de identidad de cada miembro de la tripulación (`[Nombre · rol]`) en el resumen final.
- Nada se da por terminado sin evidencia verificable (comandos ejecutados y su salida).
