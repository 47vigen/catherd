// 0.x shim: the 0.x TUI (init, dashboard) reads and tests the Jev key through here until plan 6 moves it
// onto the 1.0 services. Everything else about Jev lives in src/services/jev-service.ts.
export { jevKey, saveJevKey, testJevKey } from "../services/jev-service.ts";
