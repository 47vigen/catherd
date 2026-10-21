---
"catherd-cli": major
---

Part of 2.0.0. A detached daemon drives each run from its `events.jsonl` through a pure state machine; the session sees `run_start`, `status`, `answer`, `cancel`, `result` and `profile`; a judge role decides what no rule can; parked questions go to `notify.url` (ntfy). Runs started on 1.5 finish on 1.5.
