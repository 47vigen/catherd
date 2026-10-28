---
"catherd-cli": minor
---

Finished runs an earlier build kept on files are copied into the run-state database at a session's start, read-only, so cross-run queries see them; each run's end backs the database up under `backups/`, keeping the last seven.
