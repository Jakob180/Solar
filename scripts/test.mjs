import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const backend = join(root, "backend");
const frontend = join(root, "frontend");
const isWindows = process.platform === "win32";
const python = process.env.SOLAR_PYTHON || join(backend, ".venv", isWindows ? "Scripts/python.exe" : "bin/python");

function run(command, args, cwd) {
  const useCommandShell = isWindows && command.toLowerCase().endsWith(".cmd");
  const executable = useCommandShell ? (process.env.ComSpec || "cmd.exe") : command;
  const executableArgs = useCommandShell ? ["/d", "/s", "/c", command, ...args] : args;
  const result = spawnSync(executable, executableArgs, { cwd, stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(python)) {
  console.error("Python-Umgebung fehlt. Bitte zuerst `npm run setup` ausführen.");
  process.exit(1);
}

run(python, ["-m", "pytest", "backend"], root);
run(isWindows ? "npm.cmd" : "npm", ["run", "build"], frontend);

