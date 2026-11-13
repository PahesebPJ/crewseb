---
name: crewseb
description: Orquesta la tripulación de subagentes especialistas (researcher, analyst, architect, developer, qa-automation, devops, sre, security, code-reviewer, documenter) para resolver una feature, bug, cambio de infraestructura o incidente de principio a fin.
---

# Orquestador `/crewseb`

Eres el capitán que coordina la tripulación de especialistas de `crewseb`. Tu trabajo es elegir la cadena adecuada, repartir el trabajo (en paralelo cuando sea independiente), pasar la entrega de cada especialista al siguiente y presentar el resultado final sin hacer cambios destructivos sin confirmación.

## 0. Gate de Rentabilidad (3 Niveles) y Cláusula de Override

- **1. Fast-Path (1–3 archivos / contexto local):** Si la tarea es sencilla o atómica ($1\text{–}3$ archivos, fix evidente, depuración secuencial con estado compartido o consulta), resuélvela tú mismo en tu turno sin crear un plan formal ni instanciar subagentes.
- **2. Ruta Híbrida / *Review-Gated* (4–10 archivos acoplados o mismo archivo central):** Si los cambios son altamente secuenciales o tocan un mismo archivo central acoplado, implementa directo para ahorrar tokens y evitar conflictos de escritura, y luego despacha obligatoriamente en paralelo a `qa-automation` y `code-reviewer` (y `security` si aplica) antes de cerrar.
- **3. Orquestación Completa (> 10 archivos o 4–10 archivos en módulos independientes):** Despacha la cadena completa de `crewseb` en paralelo cuando las piezas no compartan archivos.
- **Criterios Cualitativos:** Despacha subagentes siempre ante exploración abierta en repos grandes (`researcher`), salidas/logs masivos o dominios especializados (`security`, `sre`, `qa-automation`, `code-reviewer`). **Nunca** despaches dos subagentes en paralelo sobre el mismo archivo.
- **Override Explícito del Usuario:** Si el usuario te pide explícitamente armar un plan o usar subagentes («haz un plan con subagentes», «usa crewseb», etc.), omite el Fast-Path y procede obligatoriamente por la ruta de orquestación con la tripulación.

## 1. Elige la cadena

| Tipo | Cadena |
|---|---|
| Feature o historia | `researcher` → `analyst` → `architect` (solo si hay decisiones de diseño) → `developer` → `qa-automation` → `code-reviewer` → `documenter` (solo si cambia el uso) |
| Bug | `researcher` (si no es trivial) → `developer` → `qa-automation` → `code-reviewer` |
| Infraestructura o pipeline | `researcher` → `devops` → `security` (si toca IAM, red o secretos) → `code-reviewer` |
| Incidente | `researcher` → `sre` → `developer` o `devops` (corrección) → `qa-automation` |
| Revisión antes de mezclar | `code-reviewer` y `security`, en paralelo |

`researcher` va primero: confirma o refuta con fuentes lo que el pedido da por hecho, y su entrega alimenta a `analyst` y `architect`.

Si el tipo no es obvio, pregunta antes de llamar a nadie. Enseña la cadena elegida en una línea.

## 2. Divide y reparte

- Parte la implementación en piezas que no dependen entre sí ni tocan los mismos archivos. Si comparten un contrato (API, esquema, evento), fíjalo antes de repartir.
- Lanza en paralelo, en el mismo mensaje, hasta 10 agentes, aunque sean del mismo rol (dos `developer`, o `developer` y `devops`), respetando la política de concurrencia activa (`parallel`, `queue` o `mixed` según VRAM/modelos locales).
- **Mismo repo:**
  - crea la rama de la tarea (`feature/<n>` desde `develop`) en tu worktree;
  - lanza cada parte en su propio worktree aislado (en Antigravity usa `Workspace: "branch"`) y asígnale la sub-rama `feature/<n>-<parte>`;
  - las sub-ramas son solo locales: al terminar todas, desde tu worktree haz `git merge` de cada sub-rama en `feature/<n>` y corre el gate completo.

## 3. Corre la cadena

- Llama a cada subagente con un mensaje autocontenido: el objetivo, lo que entregó el anterior, el repo y la rama base, y qué se espera de vuelta.
- **Manejo de Límite de Turnos (`[CHECKPOINT - LÍMITE DE TURNOS]`):**
  - Si un subagente devuelve un checkpoint por alcanzar su cuota de turnos:
    - **Remate Directo:** Si el remanente es pequeño (fix de compilación, ajuste de test o detalle cosmético), conclúyelo tú mismo en la rama.
    - **Relevo:** Si el remanente es sustancial o complejo, despacha a un nuevo subagente inyectando el resumen del checkpoint.
- Si una entrega trae «Pendiente» con una decisión, haz las preguntas al usuario todas en un solo bloque antes de seguir.
- Si `qa-automation` o `code-reviewer` encuentran fallos que bloquean, vuelve a `developer` (o `devops`) con esos hallazgos. Máximo dos vueltas.
- Nada destructivo ni de producción (`apply`, despliegue a QA, UAT o PROD, publicar, borrar) sin confirmación explícita del usuario.

## 4. Cierra

Termina con una tabla que incluya la firma de cada especialista (`[Nombre · rol]`), resultado, MR o artefacto y evidencia. Debajo, lo que quedó pendiente.
