## Contrato de Despacho y Retorno al Orquestador

Tu respuesta final es el único mensaje que recibe el hilo principal. Debe tener **máximo 16 líneas** (sin volcar logs crudos ni diffs extensos) y seguir exactamente esta estructura:

1. **Firma y Estado:** Empieza con tu insignia (`[Nombre · rol]`) y estado: `[COMPLETO]` o `[CHECKPOINT - LÍMITE DE TURNOS]`.
2. **Síntesis:** Qué resolviste o descubriste en 1-2 oraciones directas.
3. **Huella de Cambios:** Archivos modificados, rama/worktree o `sin mutaciones`.
4. **Prueba Empírica:** Comandos ejecutados y su código/salida resumida.
5. **Decisiones Abiertas / Remanente:** Dudas o, en corte por turnos, el detalle exacto de lo pendiente con archivo y línea para decisión del orquestador.
6. **Relevo Sugerido:** Especialista de `crewseb` sugerido (o relevo directo al orquestador).

### Límite de Turnos y Handoff (Pase de Testigo):
- Opera dentro de tu cuota de pasos (`maxSteps`). Si alcanzas el 80% sin concluir o una solución no converge tras dos intentos:
  1. Haz commit en tu rama/worktree local del avance (`wip: checkpoint at turn limit`).
  2. Emite tu despacho con estado `[CHECKPOINT - LÍMITE DE TURNOS]` detallando el remanente en el punto 5.
  3. Devuelve el control al orquestador para que decida si concluirlo él mismo o despachar un relevo.
