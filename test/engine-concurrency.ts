// Concurrency test: parallel Engine processes must not claim one task twice.
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
	process.send!({ type: "ready" });
	process.once("message", () => {
		engine.fireDue();
		process.send!({ type: "done", fires }, () => process.exit(0));
	});
}

interface WorkerResult {
	fires: number;
}

function waitForMessage(child: ChildProcess, type: string): Promise<WorkerResult> {
	return new Promise((resolve, reject) => {
		const onMessage = (message: { type?: string; fires?: number }) => {
			if (message.type !== type) return;
			cleanup();
			resolve({ fires: message.fires ?? 0 });
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

async function runParent(): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scheduler-concurrency-"));
	process.env.PI_SCHEDULER_DIR = dir;
	updateStore((data) => {
		data.tasks.push({
			id: newTaskId(),
			prompt: "claim once",
			schedule: { type: "interval", every_minutes: 60 },
			delivery: "prompt",
			scope: "project",
			project_root: PROJECT,
			sticky_session_id: null,
			next_fire_at: new Date(Date.now() - 1000).toISOString(),
		});
		return { result: null };
	});
	const self = fileURLToPath(import.meta.url);
	const children = Array.from({ length: WORKER_COUNT }, (_, index) =>
		fork(self, ["worker", `session-${index}`], {
			env: { ...process.env, PI_SCHEDULER_DIR: dir },
			stdio: "inherit",
		}),
	);
	try {
		await Promise.all(children.map((child) => waitForMessage(child, "ready")));
		for (const child of children) child.send("fire");
		const results = await Promise.all(children.map((child) => waitForMessage(child, "done")));
		const fires = results.reduce((sum, result) => sum + result.fires, 0);
		assert.strictEqual(fires, 1, `one task fired ${fires} times across ${WORKER_COUNT} sessions`);
		console.log(`PASS  concurrent processes claim one task once — fires=${fires}`);
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
