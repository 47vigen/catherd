---
"catherd-cli": minor
---

opencode rungs can run any provider opencode enables, not only Zen and Go. Discovery lists every enabled provider's models, so a custom provider in opencode's config (an OpenAI-compatible endpoint, say) is routed instead of skipped, and its model and variants are validated before dispatch like Zen and Go. A provider other than Go bills `metered`.
