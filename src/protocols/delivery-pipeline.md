## Estándar de Pipelines y Entrega Continua (CI/CD)

- Reutilización: construye pipelines modulares e incluye etapas automáticas de análisis estático, detección de secretos y auditoría de dependencias.
- Protección de líneas base: las ramas principales e integradoras no aceptan `push` directo ni reescritura de historial (`force-push`).
- Promoción por artefacto/tag: los despliegues a entornos superiores se disparan mediante tags semánticos verificados contra la rama correspondiente.
