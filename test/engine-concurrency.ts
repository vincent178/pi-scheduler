import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../extensions/scheduler/engine.ts";
import { newTaskId, touchSession, updateStore } from "../extensions/scheduler/store.ts";

const PROJECT = "/project";
const WORKER_COUNT = 8;

async function runWorker(): Promise<void> {
	const sessionId = process.argv[3]!;
	updateStore((data) => {
		touchSession(data, sessionId);
		return { result: null };
	});
	let fires = 0;
	const engine = new Engine({
		sessionId,
		cwd: PROJECT,
		projectRoot: PROJECT,
		deliverPrompt: () => { fires++; },
		notify: () => {},
		isBusy: () => false,
		onIdle: () => () => {},
	});
	const overdue = engine.collectOverdue();
	assert.equal(overdue.length, 1);
	process.send!({ type: "ready" });
	process.once("message", () => {
		engine.fireDue();
		const automatic = fires;
		engine.fireOverdue(overdue[0]);
		process.send!({ type: "done", automatic, overdue: fires - automatic }, () => process.exit(0));
	});
}

interface WorkerResult {
	automatic?: number;
	overdue?: number;
}

function waitForMessage(child: ChildProcess, type: string): Promise<WorkerResult> {
	return new Promise((resolve, reject) => {
		const onMessage = (message: WorkerResult & { type?: string }) => {
			if (message.type !== type) return;
			cleanup();
			resolve(message);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null) => {
			cleanup();
			reject(new Error(`worker exited before ${type}: ${code}`));
		};
		const cleanup = () => {
			child.off("message", onMessage);
			child.off("error", onError);
			child.off("exit", onExit);
		};
		child.on("message", onMessage);
		child.on("error", onError);
		child.on("exit", onExit);
	});
}

function addDueTask(prompt: string): void {
	updateStore((data) => {
		data.tasks.push({
			id: newTaskId(),
			prompt,
			schedule: { type: "interval", every_minutes: 60 },
			delivery: "prompt",
			scope: "project",
			project_root: PROJECT,
			sticky_session_id: null,
			next_fire_at: new Date(Date.now() - 1000).toISOString(),
		});
		return { result: null };
	});
}

async function runParent(): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduler-concurrency-"));
	process.env.PI_SCHEDULER_DIR = dir;
	addDueTask("overdue occurrence");
	const self = fileURLToPath(import.meta.url);
	const children = Array.from({ length: WORKER_COUNT }, (_, index) =>
		fork(self, ["worker", `session-${index}`], {
			env: { ...process.env, PI_SCHEDULER_DIR: dir },
			stdio: "inherit",
		}),
	);
	try {
		await Promise.all(children.map((child) => waitForMessage(child, "ready")));
		addDueTask("automatic occurrence");
		const done = Promise.all(children.map((child) => waitForMessage(child, "done")));
		for (const child of children) child.send("fire");
		const results = await done;
		for (const trigger of ["automatic", "overdue"] as const) {
			const fires = results.reduce((sum, result) => sum + (result[trigger] ?? 0), 0);
			assert.equal(fires, 1, `${trigger} occurrence fired ${fires} times across ${WORKER_COUNT} sessions`);
			console.log(`PASS  concurrent claims for ${trigger} occurrence — fires=${fires}`);
		}
		console.log("\nALL CHECKS PASSED");
	} finally {
		for (const child of children) child.kill();
	}
}

if (process.argv[2] === "worker") {
	await runWorker();
} else {
	await runParent();
}
