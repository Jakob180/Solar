import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const backend = join(root, "backend");
const frontend = join(root, "frontend");
const isWindows = process.platform === "win32";
const python = process.env.SOLAR_PYTHON || join(backend, ".venv", isWindows ? "Scripts/python.exe" : "bin/python");
const viteCli = join(frontend, "node_modules", "vite", "bin", "vite.js");
const preview = process.argv.includes("--preview");

if (!existsSync(python)) {
  console.error("Python-Umgebung fehlt. Bitte zuerst `npm run setup` ausführen.");
  process.exit(1);
}
if (!existsSync(viteCli)) {
  console.error("Frontend-Abhängigkeiten fehlen. Bitte zuerst `npm run setup` ausführen.");
  process.exit(1);
}

const children = [];
function launch(label, command, args, cwd) {
  const useCommandShell = isWindows && command.toLowerCase().endsWith(".cmd");
  const executable = useCommandShell ? (process.env.ComSpec || "cmd.exe") : command;
  const executableArgs = useCommandShell ? ["/d", "/s", "/c", command, ...args] : args;
  const child = spawn(executable, executableArgs, { cwd, stdio: "inherit", shell: false });
  children.push(child);
  child.on("exit", (code) => {
    if (!stopping && code !== 0) {
      console.error(`${label} wurde mit Code ${code} beendet.`);
      stop(code ?? 1);
    }
  });
}

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.killed || !child.pid) continue;
    if (isWindows) {
      // Node's kill() only stops cmd.exe, not the npm/Vite or uvicorn children.
      // Targeting the exact spawned PID tree prevents orphaned local servers.
      spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => process.exit(code), 250);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

console.log(`Solar Potential startet${preview ? " (Produktionsbuild)" : ""}: UI http://localhost:5173 · API http://localhost:8000/docs`);
launch("Backend", python, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"], backend);
launch(
  "Frontend",
  process.execPath,
  [viteCli, ...(preview ? ["preview"] : []), "--host", "127.0.0.1", "--port", "5173"],
  frontend,
);

