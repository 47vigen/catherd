import { z } from "zod";
import { errorMessage } from "../../domain/errors.ts";
import { ROLES } from "../../domain/roles.ts";
import { restoreTmpdir } from "../../infra/env.ts";
import { startRoleMcpServer } from "./role-server.ts";

try {
  const [role, run] = z.tuple([z.enum(ROLES), z.string().min(1)]).parse(process.argv.slice(2));
  restoreTmpdir(process.env);
  await startRoleMcpServer({ role, run });
} catch (e) {
  console.error(`catherd role MCP: ${errorMessage(e)}`);
  process.exitCode = 1;
}
