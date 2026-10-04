#!/usr/bin/env node
// Runs cargo commands for packages/indexer from the root yarn scripts.
//
// The indexer is a Rust crate, which yarn workspaces do not manage. When cargo is not installed, the
// build/test/lint steps print a clear warning and exit 0 so a JavaScript-only machine can still install,
// lint and build the contracts and frontend. `run` always needs cargo and fails with install instructions.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const indexerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "indexer");

const steps = {
  build: [["build"]],
  test: [["test"]],
  lint: [["fmt", "--check"], ["clippy", "--all-targets", "--", "-D", "warnings"]],
  run: [["run", "--release"]],
};

const command = process.argv[2];
if (!steps[command]) {
  console.error(`Usage: node scripts/cargo.mjs <${Object.keys(steps).join("|")}>`);
  process.exit(2);
}

const probe = spawnSync("cargo", ["--version"], { stdio: "ignore" });
if (probe.error || probe.status !== 0) {
  const message = "cargo (Rust) is not installed. Install it from https://rustup.rs to use the indexer.";
  if (command === "run") {
    console.error(`error: ${message}`);
    process.exit(1);
  }
  console.warn(`warning: ${message}\n         Skipping indexer "${command}"; contracts and frontend are unaffected.`);
  process.exit(0);
}

for (const args of steps[command]) {
  const result = spawnSync("cargo", args, { cwd: indexerDir, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
