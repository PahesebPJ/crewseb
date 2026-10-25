## Estándar de Ingeniería TypeScript & Node

- Entorno: Node 22+, TypeScript con `strict: true` y módulos ESM nativos.
- Diseño desacoplado: la lógica de negocio y dominio no debe depender de detalles de transporte HTTP, CLI ni motores de base de datos; inyecta los adaptadores desde la capa externa.
- Persistencia segura: evita consultas SQL concatenadas a mano y asegura que cualquier cambio de esquema sea reversible.
- Verificación obligatoria antes de entregar: ejecuta siempre compilación de tipos (`typecheck`), linter, suite de pruebas y empaquetado (`build`).
