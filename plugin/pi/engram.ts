import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const ENGRAM_PORT = Number.parseInt(process.env.ENGRAM_PORT ?? "7437", 10);
const ENGRAM_URL = `http://127.0.0.1:${ENGRAM_PORT}`;
const ENGRAM_BIN = process.env.ENGRAM_BIN ?? "engram";

const MEMORY_PROTOCOL = `## Engram Persistent Memory — Protocol

You have access to Engram persistent memory via tools.

### WHEN TO SAVE (mandatory)

Call engram_save IMMEDIATELY after:
- Bugfixes
- Architecture/design decisions
- Non-obvious discoveries
- Config/environment changes
- Patterns/conventions
- User preferences/constraints

Use structure:
- What
- Why
- Where
- Learned (if relevant)

### WHEN TO SEARCH

Search memory when user references previous work ("remember", "what did we do", "last time").

Use progressive retrieval:
1. engram_search
2. engram_timeline
3. engram_get

Also search proactively before starting work that may overlap with prior sessions.

### SESSION CLOSE (mandatory)

Before ending or saying done, call engram_session_summary with:
- Goal
- Discoveries
- Accomplished
- Next Steps
- Relevant Files

### AFTER COMPACTION

If context was compacted/reset:
1. Save compacted content with engram_session_summary
2. Call engram_context to recover recent context
3. Continue only after recovery`;

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripPrivateTags(text: string): string {
	if (!text) return "";
	return text.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]").trim();
}

function extractProjectName(cwd: string): string {
	try {
		const remote = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8" });
		if (remote.status === 0 && remote.stdout?.trim()) {
			const name = remote.stdout.trim().replace(/\.git$/, "").split(/[/:]/).pop();
			if (name) return name;
		}
	} catch {}

	try {
		const top = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
		if (top.status === 0 && top.stdout?.trim()) {
			const base = path.basename(top.stdout.trim());
			if (base) return base;
		}
	} catch {}

	return path.basename(cwd) || "unknown";
}

async function engramFetch(urlPath: string, init: RequestInit = {}): Promise<any> {
	const response = await fetch(`${ENGRAM_URL}${urlPath}`, {
		...init,
		headers: init.body ? { "Content-Type": "application/json", ...(init.headers ?? {}) } : init.headers,
	});

	const raw = await response.text();
	let parsed: any = raw;
	try {
		parsed = raw ? JSON.parse(raw) : {};
	} catch {}

	if (!response.ok) {
		const message = typeof parsed === "object" && parsed?.error ? String(parsed.error) : raw || response.statusText;
		throw new Error(message);
	}

	return parsed;
}

async function isServerRunning(): Promise<boolean> {
	try {
		const res = await fetch(`${ENGRAM_URL}/health`, { signal: AbortSignal.timeout(600) });
		return res.ok;
	} catch {
		return false;
	}
}

function toText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}

function assistantTextFromTurnMessage(message: any): string {
	const content = message?.content;
	if (!Array.isArray(content)) return "";
	const chunks = content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text.trim())
		.filter(Boolean);
	return chunks.join("\n\n");
}

export default function engramPiExtension(pi: ExtensionAPI) {
	let project = "unknown";
	let initialContext = "";
	let contextInjected = false;
	let compactionSummaryToPersist = "";
	const knownSessions = new Set<string>();

	const ensureServer = async () => {
		if (await isServerRunning()) return;
		try {
			const child = spawn(ENGRAM_BIN, ["serve"], {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			});
			child.unref();
			await sleep(500);
		} catch {
			// ignore; tools will return a clear error if server is unavailable
		}
	};

	const ensureSession = async (ctx: ExtensionContext): Promise<string> => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) throw new Error("No active pi session id");
		if (knownSessions.has(sessionId)) return sessionId;
		await engramFetch("/sessions", {
			method: "POST",
			body: JSON.stringify({ id: sessionId, project, directory: ctx.cwd }),
		});
		knownSessions.add(sessionId);
		return sessionId;
	};

	pi.on("session_start", async (_event, ctx) => {
		project = extractProjectName(ctx.cwd);
		contextInjected = false;
		initialContext = "";
		compactionSummaryToPersist = "";

		await ensureServer();

		const oldProject = path.basename(ctx.cwd) || "unknown";
		if (oldProject && oldProject !== project) {
			try {
				await engramFetch("/projects/migrate", {
					method: "POST",
					body: JSON.stringify({ old_project: oldProject, new_project: project }),
				});
			} catch {
				// non-fatal
			}
		}

		try {
			await ensureSession(ctx);
		} catch (err) {
			ctx.ui.notify(`Engram session init failed: ${String(err)}`, "warning");
		}

		try {
			const manifestPath = path.join(ctx.cwd, ".engram", "manifest.json");
			if (fs.existsSync(manifestPath)) {
				spawn(ENGRAM_BIN, ["sync", "--import"], {
					cwd: ctx.cwd,
					stdio: "ignore",
					windowsHide: true,
				});
			}
		} catch {
			// non-fatal
		}

		try {
			const data = await engramFetch(`/context?project=${encodeURIComponent(project)}`);
			initialContext = typeof data?.context === "string" ? data.context : "";
		} catch {
			initialContext = "";
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await ensureServer();

		let sessionId = "";
		try {
			sessionId = await ensureSession(ctx);
		} catch {}

		if (sessionId && event.prompt?.trim()) {
			try {
				await engramFetch("/prompts", {
					method: "POST",
					body: JSON.stringify({
						session_id: sessionId,
						content: stripPrivateTags(event.prompt).slice(0, 4000),
						project,
					}),
				});
			} catch {
				// non-fatal
			}
		}

		let systemPrompt = `${event.systemPrompt}\n\n${MEMORY_PROTOCOL}`;
		if (compactionSummaryToPersist) {
			systemPrompt += `\n\nFIRST ACTION REQUIRED: call engram_session_summary with the compacted summary content before any other work, then call engram_context (project: ${project}).\n\nCompacted summary:\n${compactionSummaryToPersist}`;
			compactionSummaryToPersist = "";
		}

		if (!contextInjected && initialContext.trim()) {
			contextInjected = true;
			return {
				systemPrompt,
				message: {
					customType: "engram-context",
					content: `## Engram memory context\n\n${initialContext}`,
					display: false,
				},
			};
		}

		return { systemPrompt };
	});

	pi.on("turn_end", async (event, ctx) => {
		const text = assistantTextFromTurnMessage(event.message);
		if (!text || !/##\s*Key Learnings:/i.test(text)) return;
		try {
			const sessionId = await ensureSession(ctx);
			await engramFetch("/observations/passive", {
				method: "POST",
				body: JSON.stringify({
					session_id: sessionId,
					project,
					source: "pi-turn-end",
					content: stripPrivateTags(text),
				}),
			});
		} catch {
			// non-fatal
		}
	});

	pi.on("session_compact", async (event) => {
		compactionSummaryToPersist = event.compactionEntry.summary;
		contextInjected = false;
		try {
			const data = await engramFetch(`/context?project=${encodeURIComponent(project)}`);
			initialContext = typeof data?.context === "string" ? data.context : initialContext;
		} catch {
			// non-fatal
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			if (sessionId) {
				await engramFetch(`/sessions/${encodeURIComponent(sessionId)}/end`, {
					method: "POST",
					body: JSON.stringify({}),
				});
			}
		} catch {
			// non-fatal
		}
	});

	pi.registerTool({
		name: "engram_search",
		label: "Engram Search",
		description: "Search persistent memories",
		promptSnippet: "Search engram memory by keyword",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(Type.Number({ description: "Max results" })),
			type: Type.Optional(Type.String({ description: "Filter by memory type" })),
			project: Type.Optional(Type.String({ description: "Project name" })),
			scope: Type.Optional(Type.String({ description: "Scope filter" })),
		}),
		async execute(_toolCallId, params) {
			const q = new URLSearchParams({ q: params.query });
			if (params.limit !== undefined) q.set("limit", String(params.limit));
			if (params.type) q.set("type", params.type);
			if (params.project) q.set("project", params.project);
			if (params.scope) q.set("scope", params.scope);
			const result = await engramFetch(`/search?${q.toString()}`);
			return { content: [{ type: "text", text: toText(result) }], details: { count: Array.isArray(result) ? result.length : 0 } };
		},
	});

	pi.registerTool({
		name: "engram_context",
		label: "Engram Context",
		description: "Load recent context from previous sessions",
		promptSnippet: "Load recent engram context",
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "Project name" })),
			scope: Type.Optional(Type.String({ description: "Scope filter" })),
		}),
		async execute(_toolCallId, params) {
			const q = new URLSearchParams();
			q.set("project", params.project || project);
			if (params.scope) q.set("scope", params.scope);
			const result = await engramFetch(`/context?${q.toString()}`);
			return { content: [{ type: "text", text: toText(result) }], details: {} };
		},
	});

	pi.registerTool({
		name: "engram_save",
		label: "Engram Save",
		description: "Save a durable memory observation",
		promptSnippet: "Save memory to engram",
		parameters: Type.Object({
			title: Type.String({ description: "Short title" }),
			content: Type.String({ description: "Observation content" }),
			type: Type.Optional(Type.String({ description: "Type (bugfix, decision, discovery, etc.)" })),
			project: Type.Optional(Type.String({ description: "Project name" })),
			scope: Type.Optional(Type.String({ description: "Scope" })),
			topic: Type.Optional(Type.String({ description: "Stable topic key" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = await ensureSession(ctx);
			const body = {
				session_id: sessionId,
				title: params.title,
				content: stripPrivateTags(params.content),
				type: params.type ?? "note",
				project: params.project ?? project,
				scope: params.scope ?? "project",
				topic_key: params.topic,
			};
			const saved = await engramFetch("/observations", { method: "POST", body: JSON.stringify(body) });
			return { content: [{ type: "text", text: toText(saved) }], details: {} };
		},
	});

	pi.registerTool({
		name: "engram_timeline",
		label: "Engram Timeline",
		description: "Show chronological context around an observation",
		parameters: Type.Object({
			observation_id: Type.Number({ description: "Observation ID" }),
			before: Type.Optional(Type.Number({ description: "Entries before" })),
			after: Type.Optional(Type.Number({ description: "Entries after" })),
		}),
		async execute(_toolCallId, params) {
			const q = new URLSearchParams({ observation_id: String(params.observation_id) });
			if (params.before !== undefined) q.set("before", String(params.before));
			if (params.after !== undefined) q.set("after", String(params.after));
			const result = await engramFetch(`/timeline?${q.toString()}`);
			return { content: [{ type: "text", text: toText(result) }], details: {} };
		},
	});

	pi.registerTool({
		name: "engram_get",
		label: "Engram Get",
		description: "Get full memory observation by ID",
		parameters: Type.Object({
			id: Type.Number({ description: "Observation ID" }),
		}),
		async execute(_toolCallId, params) {
			const result = await engramFetch(`/observations/${params.id}`);
			return { content: [{ type: "text", text: toText(result) }], details: {} };
		},
	});

	pi.registerTool({
		name: "engram_update",
		label: "Engram Update",
		description: "Update an existing memory by ID",
		parameters: Type.Object({
			id: Type.Number({ description: "Observation ID" }),
			title: Type.Optional(Type.String({ description: "Updated title" })),
			content: Type.Optional(Type.String({ description: "Updated content" })),
			type: Type.Optional(Type.String({ description: "Updated type" })),
			project: Type.Optional(Type.String({ description: "Updated project" })),
			scope: Type.Optional(Type.String({ description: "Updated scope" })),
			topic: Type.Optional(Type.String({ description: "Updated topic key" })),
		}),
		async execute(_toolCallId, params) {
			const patch: Record<string, unknown> = {};
			if (params.title !== undefined) patch.title = params.title;
			if (params.content !== undefined) patch.content = stripPrivateTags(params.content);
			if (params.type !== undefined) patch.type = params.type;
			if (params.project !== undefined) patch.project = params.project;
			if (params.scope !== undefined) patch.scope = params.scope;
			if (params.topic !== undefined) patch.topic_key = params.topic;
			const result = await engramFetch(`/observations/${params.id}`, {
				method: "PATCH",
				body: JSON.stringify(patch),
			});
			return { content: [{ type: "text", text: toText(result) }], details: {} };
		},
	});

	pi.registerTool({
		name: "engram_delete",
		label: "Engram Delete",
		description: "Delete a memory observation by ID",
		parameters: Type.Object({
			id: Type.Number({ description: "Observation ID" }),
			hard: Type.Optional(Type.Boolean({ description: "Hard delete permanently" })),
		}),
		async execute(_toolCallId, params) {
			const q = params.hard ? "?hard=true" : "";
			const result = await engramFetch(`/observations/${params.id}${q}`, { method: "DELETE" });
			return { content: [{ type: "text", text: toText(result) }], details: {} };
		},
	});

	pi.registerTool({
		name: "engram_session_summary",
		label: "Engram Session Summary",
		description: "Save end-of-session summary",
		promptSnippet: "Save session summary to engram",
		parameters: Type.Object({
			content: Type.String({ description: "Session summary markdown" }),
			project: Type.Optional(Type.String({ description: "Project name" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = await ensureSession(ctx);
			const targetProject = params.project ?? project;
			const result = await engramFetch("/observations", {
				method: "POST",
				body: JSON.stringify({
					session_id: sessionId,
					type: "session_summary",
					title: `Session summary: ${targetProject}`,
					content: stripPrivateTags(params.content),
					project: targetProject,
					scope: "project",
				}),
			});
			return { content: [{ type: "text", text: toText(result) }], details: {} };
		},
	});

	pi.registerTool({
		name: "engram_stats",
		label: "Engram Stats",
		description: "Show memory system statistics",
		parameters: Type.Object({}),
		async execute() {
			const result = await engramFetch("/stats");
			return { content: [{ type: "text", text: toText(result) }], details: {} };
		},
	});
}
