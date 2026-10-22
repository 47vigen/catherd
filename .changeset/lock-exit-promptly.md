---
"catherd-cli": patch
---

`catherd lock` exits as soon as its command does; it no longer holds the process open for the half second it allows the command's pipes to drain.
