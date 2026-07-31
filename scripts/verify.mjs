import { spawnSync } from "node:child_process";

const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack";
const includeInstall = process.argv.includes("--install");

const steps = [
  ...(includeInstall ? [{ name: "install", args: ["pnpm", "install", "--frozen-lockfile"] }] : []),
  { name: "build", args: ["pnpm", "build"] },
  {
    name: "typecheck",
    args: [
      "pnpm",
      "-r",
      "--workspace-concurrency=1",
      "--if-present",
      "run",
      "typecheck",
    ],
  },
  { name: "lint", args: ["pnpm", "lint"] },
  { name: "test", args: ["pnpm", "test"] },
];

for (const step of steps) {
  process.stdout.write(`\n[verify] ${step.name}\n`);
  const result = spawnSync(corepack, step.args, {
    cwd: process.cwd(),
    env: process.env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`[verify] ${step.name} could not start`, result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[verify] ${step.name} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

process.stdout.write("\n[verify] all checks passed\n");
