import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { ScheduledTask } from "./store.ts";

/** Git repo root when inside a repo, otherwise the directory itself. */
export function resolveProjectRoot(cwd: string): string {
  try {
    const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) return root;
  } catch {
    // Not a git repo (or git unavailable): the directory is the project.
  }
  return path.resolve(cwd);
}

export function inScope(task: Pick<ScheduledTask, "scope" | "project_root">, cwd: string): boolean {
  if (task.scope === "global") return true;
  if (!task.project_root) return false;
  const root = task.project_root;
  return cwd === root || cwd.startsWith(root + path.sep);
}
