import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const backend = join(root, "backend");
const frontend = join(root, "frontend");
const isWindows = process.platform === "win32";
const venvPython = join(backend, ".venv", isWindows ? "Scripts/python.exe" : "bin/python");
const systemPython = process.env.SOLAR_SYSTEM_PYTHON || (isWindows ? "python" : "python3");

function run(command, args, cwd = root) {
  const useCommandShell = isWindows && command.toLowerCase().endsWith(".cmd");
  const executable = useCommandShell ? (process.env.ComSpec || "cmd.exe") : command;
  const executableArgs = useCommandShell ? ["/d", "/s", "/c", command, ...args] : args;
  const result = spawnSync(executable, executableArgs, { cwd, stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(venvPython)) {
  console.log("Erstelle Python-Umgebung …");
  run(systemPython, ["-m", "venv", ".venv"], backend);
}

console.log("Installiere Backend-Abhängigkeiten …");
run(venvPython, ["-m", "pip", "install", "-r", "requirements-dev.txt"], backend);

console.log("Installiere Frontend-Abhängigkeiten …");
run(isWindows ? "npm.cmd" : "npm", ["install"], frontend);

console.log("Setup abgeschlossen. Starte mit: npm run dev");

