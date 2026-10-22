---
"catherd-cli": patch
---

`catherd init` no longer waits 1.5 s and asks opencode for its models a second time when the opencode CLI did not answer at all; the retry stays for a service that answered with an empty list.
