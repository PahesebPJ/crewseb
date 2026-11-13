---
trigger: always_on
---

# Reglas activas de crewseb en Antigravity

- **Gate de Rentabilidad (3 Niveles):**
  - **Ruta Rápida (1–3 archivos):** Tareas atómicas, fixes evidentes, depuración secuencial o consultas; resuélvelas directamente sin plan multi-paso ni subagentes.
  - **Ruta Híbrida / *Review-Gated* (4–10 archivos acoplados o mismo archivo central):** Implementa directo para evitar conflictos de escritura, pero **audita obligatoriamente en paralelo con `qa-automation` y `code-reviewer`** antes de cerrar.
  - **Ruta Orquestada (> 10 archivos o 4–10 archivos en módulos paralelizables):** Usa la tripulación completa.
- **Criterios Cualitativos:** Despacha subagentes ante exploración abierta en repos grandes (`researcher`), logs masivos o dominios especializados (`security`, `sre`); **nunca** lances dos subagentes en paralelo a editar el mismo archivo.
- **Override Explícito:** Si el usuario pide explícitamente armar un plan o usar subagentes («haz un plan con subagentes», «usa crewseb»), procede siempre por la ruta del plan con la tripulación.
- Todo plan de implementación complejo (más de un paso) debe cerrar con una tabla de delegación hacia los subagentes de `crewseb`: `researcher`, `analyst`, `architect`, `developer`, `qa-automation`, `devops`, `sre`, `security`, `code-reviewer` y `documenter`.
- Al ejecutarse el plan, delega con `invoke_subagent` (usando `Workspace: "branch"` cuando lances subagentes en paralelo dentro del mismo repositorio).
- **Handoff por Límite de Turnos:** Si un subagente devuelve `[CHECKPOINT - LÍMITE DE TURNOS]`, evalúa el remanente: si es pequeño, termínalo tú mismo en la rama; si es extenso, delega el relevo a un nuevo subagente.
- Respeta siempre la firma de identidad de cada miembro de la tripulación (`[Nombre · rol]`) en el resumen final.
- Nada se da por terminado sin evidencia verificable (comandos ejecutados y su salida).
