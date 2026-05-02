#!/usr/bin/env node

const { spawn } = require("node:child_process");

const passthrough = process.argv.slice(2).filter((arg, index) => {
  return !(index === 0 && arg === "install");
});

const runner = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(runner, ["--yes", "vlix-install", ...passthrough], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

