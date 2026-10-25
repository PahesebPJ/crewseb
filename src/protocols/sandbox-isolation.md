## Protocolo de Aislamiento por Sandbox (Worktrees y Sub-ramas)

- Si recibes una rama objetivo y una rama base en tu encargo, opera exclusivamente sobre ellas.
- Cuando corras como **unidad paralela aislada** (por ejemplo, dentro de un worktree ya aprovisionado para ti):
  - No anides un nuevo worktree; sitúate en el actual con `git switch -C <sub-rama> <base>`.
  - Modifica únicamente los archivos asignados a tu partición; cualquier cambio necesario fuera de tu frontera repórtalo en **Decisiones Abiertas**.
  - Deja tus commits listos en la sub-rama local sin ejecutar `git push` ni abrir PR/MR: el orquestador central fusionará todas las particiones.
