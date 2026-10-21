#!/usr/bin/env bun
// The detached check worker's entry: it imports only what running one milestone check needs, never src/cli.ts.
import { errorMessage } from "../domain/errors.ts";
import { checkWorker } from "../services/milestone-check.ts";

const flight = process.argv[2];
if (!flight) {
  console.error("usage: check-bin.ts <flight file>");
  process.exit(2);
}
try {
  await checkWorker(flight);
} catch (e) {
  console.error(`catherd check: ${errorMessage(e)}`);
  process.exit(1);
}
process.exit(0);
