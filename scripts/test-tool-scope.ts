// Scope-policy verification for the list/cancel tools. Run: node scripts/test-tool-scope.ts
import { inScope } from "../extensions/scheduler/project.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const root = "/repo/a";
const projectTask = { scope: "project" as const, project_root: root };
const globalTask = { scope: "global" as const, project_root: null };
const orphanTask = { scope: "project" as const, project_root: null };

check("same dir is in scope", inScope(projectTask, root));
check("subdir is in scope", inScope(projectTask, "/repo/a/sub/dir"));
check("sibling project is out of scope", !inScope(projectTask, "/repo/b"));
check("parent dir is out of scope", !inScope(projectTask, "/repo"));
check("global task is in scope anywhere", inScope(globalTask, "/anywhere"));
check("project task without root is out of scope", !inScope(orphanTask, root));
check("prefix-similar dir is out of scope", !inScope(projectTask, "/repo/ab"));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
