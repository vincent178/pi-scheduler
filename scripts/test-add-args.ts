// /remind add argument-splitting verification. Run: node scripts/test-add-args.ts
import { parseAddArgs } from "../extensions/reminder/index.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function expect(input: string, when: string, prompt: string, global = false, notify = false): void {
  try {
    const a = parseAddArgs(input);
    check(
      `"${input}"`,
      a.when === when && a.prompt === prompt && a.global === global && a.notify === notify,
      JSON.stringify(a),
    );
  } catch (err) {
    check(`"${input}"`, false, String(err));
  }
}

expect("in 30m check the deploy", "in 30m", "check the deploy");
expect("at 15:00 stretch break", "at 15:00", "stretch break");
expect("every 45 minutes poll CI", "every 45 minutes", "poll CI");
expect("every 2h water the plants", "every 2h", "water the plants");
expect("tomorrow at 9am standup notes", "tomorrow at 9am", "standup notes");
expect("2026-12-25T09:00:00 open presents", "2026-12-25T09:00:00", "open presents");
expect("in 30m check the deploy --global", "in 30m", "check the deploy", true);
expect("in 30m check the deploy --notify", "in 30m", "check the deploy", false, true);
expect("--global --notify in 30m stretch", "in 30m", "stretch", true, true);

// explicit separator for prompts that themselves start with time words
expect("in 1h -- at 15:00 ping me again", "in 1h", "at 15:00 ping me again");

// errors
for (const bad of ["", "check the deploy", "in 30m"]) {
  let threw = false;
  try {
    parseAddArgs(bad);
  } catch {
    threw = true;
  }
  check(`"${bad || "(empty)"}" throws`, threw);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
