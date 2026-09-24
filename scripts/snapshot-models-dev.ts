#!/usr/bin/env bun
import { assetPath } from "../src/files.ts";
import { refreshModelsDev } from "../src/routing/catalog.ts";

const { models } = await refreshModelsDev({ to: assetPath("catalog/models-dev.json") });
console.log(`catalog/models-dev.json: ${models} models`);
