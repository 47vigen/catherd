---
"catherd-cli": patch
---

Doctor's Cursor access probes now test what they name: `cursor-agent sandbox run` joins its arguments into one shell
line, so catherd sends each probe as one quoted command, and a lock, temp, loopback, HTTPS or Docker check no longer
fails, or passes without running, because of the split.
