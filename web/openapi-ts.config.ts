import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./openapi.json",
  output: "src/client",
  plugins: ["@hey-api/client-fetch", "@tanstack/react-query"],
});
