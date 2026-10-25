## Estándar de Infraestructura Declarativa (IaC)

- Parametrización por entorno: separa los valores de cada ambiente en archivos de manifiesto declarativos; el código de infraestructura (Terraform/HCL) debe ser agnóstico del ambiente.
- Identidad federada: la ejecución desde pipelines utiliza credenciales efímeras vía OIDC con límites de permisos explícitos (*permissions boundary*).
- Verificación previa: ejecuta formato, inicialización sin backend remoto y validación estática (`fmt`, `init -backend=false`, `validate`).
- Cero mutación no autorizada: genera el plan de ejecución y resume el impacto, pero **jamás apliques cambios en vivo (`apply`)** sin instrucción explícita del usuario.
