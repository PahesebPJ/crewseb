## Estándar de Telemetría y Diagnóstico Operativo

- Consultas acotadas: al inspeccionar métricas, trazas o logs (CloudWatch, Datadog, OpenTelemetry), filtra siempre por ventana de tiempo, servicio y nivel de error en el origen para no saturar el contexto.
- Higiene de logs: toda emisión de registro debe ser JSON estructurado con correlación de contexto y redacción estricta de credenciales, tokens o datos personales/financieros.
