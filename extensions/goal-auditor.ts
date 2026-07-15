import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { truncateText } from "./goal-core.ts";
import type { GoalRecord } from "./goal-record.ts";

export interface GoalAuditorConfig {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface GoalAuditorResult {
	approved: boolean;
	disapproved: boolean;
	output: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	error?: string;
}

/**
 * Live progress events emitted by the auditor sub-agent while it inspects the
 * workspace. Relayed to the parent tool's onUpdate so the TUI shows what the
 * auditor is doing instead of a static "Working...".
 */
export type GoalAuditorProgressEvent =
	| { kind: "tool_start"; toolName: string; args: unknown }
	| { kind: "tool_end"; toolName: string; isError: boolean }
	| { kind: "assistant_text"; text: string };

/** Human-readable one-line description of an auditor activity, for live UI. */
export function formatAuditorActivity(event: GoalAuditorProgressEvent): string {
	switch (event.kind) {
		case "assistant_text": {
			const text = event.text.trim();
			if (!text) return "Auditor ▸ reasoning…";
			const firstLine = text.split("\n").find((line) => line.trim()) ?? "";
			return `Auditor ▸ ${truncateText(firstLine, 100)}`;
		}
		case "tool_end":
			return `Auditor ▸ ${event.toolName}${event.isError ? " (error)" : " ✓"}`;
		case "tool_start": {
			const detail = auditorToolDetail(event.toolName, event.args as Record<string, unknown> | undefined);
			return `Auditor ▸ ${event.toolName}${detail ? ` ${detail}` : ""}`;
		}
	}
}

/** Extract a human-readable detail from tool arguments without hard-coding
 * tool-specific field names.  Special-cases grep (pattern wrapping) and bash
 * (whitespace collapse) for nicer display; everything else uses the first
 * meaningful string argument found.
 */
function auditorToolDetail(toolName: string, args: Record<string, unknown> | undefined): string | undefined {
	if (!args) return undefined;

	// grep: wrap the pattern in slashes so it's instantly recognisable
	if (toolName === "grep") {
		const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
		if (pattern) return `/${truncateText(pattern, 60)}/`;
	}

	// bash: collapse whitespace so multi-line commands don't sprawl
	if (toolName === "bash") {
		const cmd = typeof args.command === "string" ? args.command.replace(/\s+/g, " ").trim() : "";
		if (cmd) return truncateText(cmd, 80);
	}

	// Generic: try common field names first, then fall back to any string value
	for (const key of ["path", "file_path", "pattern", "glob", "name"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return truncateText(value.trim(), 80);
	}
	for (const value of Object.values(args)) {
		if (typeof value === "string" && value.trim()) return truncateText(value.trim(), 80);
	}
	return undefined;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function goalAuditorConfigPath(cwd: string): string {
	return path.join(cwd, ".pi", "goal-auditor.json");
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
	const text = asNonEmptyString(value);
	return text && THINKING_LEVELS.has(text) ? text as ThinkingLevel : undefined;
}

export function parseGoalAuditorConfig(raw: unknown): GoalAuditorConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const record = raw as Record<string, unknown>;
	const config: GoalAuditorConfig = {};
	const provider = asNonEmptyString(record.provider);
	const model = asNonEmptyString(record.model);
	const thinkingLevel = asThinkingLevel(record.thinkingLevel ?? record.thinking_level);
	if (provider) config.provider = provider;
	if (model) config.model = model;
	if (thinkingLevel) config.thinkingLevel = thinkingLevel;
	return config;
}

export function loadGoalAuditorFileConfig(cwd: string): GoalAuditorConfig {
	try {
		const configPath = goalAuditorConfigPath(cwd);
		if (fs.existsSync(configPath)) return parseGoalAuditorConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
	} catch {
		return {};
	}
	return {};
}

export function loadGoalAuditorConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): GoalAuditorConfig {
	const fileConfig = loadGoalAuditorFileConfig(cwd);
	return {
		...fileConfig,
		provider: asNonEmptyString(env.PI_GOAL_AUDITOR_PROVIDER) ?? fileConfig.provider,
		model: asNonEmptyString(env.PI_GOAL_AUDITOR_MODEL) ?? fileConfig.model,
		thinkingLevel: asThinkingLevel(env.PI_GOAL_AUDITOR_THINKING_LEVEL ?? env.PI_GOAL_AUDITOR_THINKING) ?? fileConfig.thinkingLevel,
	};
}

export function saveGoalAuditorFileConfig(cwd: string, config: GoalAuditorConfig): GoalAuditorConfig {
	const clean: GoalAuditorConfig = {};
	const provider = asNonEmptyString(config.provider);
	const model = asNonEmptyString(config.model);
	const thinkingLevel = asThinkingLevel(config.thinkingLevel);
	if (provider) clean.provider = provider;
	if (model) clean.model = model;
	if (thinkingLevel) clean.thinkingLevel = thinkingLevel;
	const configPath = goalAuditorConfigPath(cwd);
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	const persisted: Record<string, string> = {};
	if (clean.provider) persisted.provider = clean.provider;
	if (clean.model) persisted.model = clean.model;
	if (clean.thinkingLevel) persisted.thinking_level = clean.thinkingLevel;
	fs.writeFileSync(configPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
	return clean;
}

export function parseAuditorDecision(output: string): { approved: boolean; disapproved: boolean } {
	const approved = /<approved\s*\/>/.test(output);
	const disapproved = /<disapproved\s*\/>/.test(output);
	return { approved: approved && !disapproved, disapproved };
}

export function buildGoalAuditorPrompt(args: {
	goal: GoalRecord;
	completionSummary?: string | null;
	detailedSummary: string;
}): string {
	return [
		"You are the independent completion auditor for pi-goal.",
		"The executor claims the goal is complete. Your job is to decide whether the user's objective is actually satisfied.",
		"Be skeptical and semantic. Do not approve from paperwork, intent, file count, word count, build success, or a plausible summary alone.",
		"Use read/grep/find/ls/bash as needed to inspect real artifacts. Do not mutate files or run destructive commands.",
		"If the work is only an alpha scaffold, generated template, shallow draft, proxy milestone, or lacks the user-facing value requested, disapprove.",
		"If any explicit requirement is missing, weakly verified, contradicted, or not inspectable with the available evidence, disapprove.",
		"Return a concise audit report. The final line MUST be exactly one of:",
		"<approved/>",
		"<disapproved/>",
		"",
		"Goal objective:",
		"<objective>",
		args.goal.objective,
		"</objective>",
		"",
		"Executor completion claim:",
		"<completion_summary>",
		args.completionSummary?.trim() || "(none provided)",
		"</completion_summary>",
		"",
		"Current goal metadata:",
		"<goal_details>",
		args.detailedSummary,
		"</goal_details>",
		"",
		"Audit checklist:",
		"1. Extract the real success criteria from the objective, including quality/reader outcomes.",
		"2. Inspect artifacts or command output that can prove or disprove those criteria.",
		"3. Explain missing or weak evidence, especially scaffold-vs-final quality gaps.",
		"4. End with exactly <approved/> only if the objective is truly complete; otherwise end with exactly <disapproved/>.",
	].join("\n");
}

function makeAuditorResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => [
			"You are a read-only completion auditor running in an isolated pi agent session.",
			"Inspect the repository and decide whether the claimed goal completion is genuinely satisfied.",
			"Never modify files. Never approve unless the actual user objective is complete.",
		].join("\n"),
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function resolveAuditorModel(ctx: ExtensionContext, config: GoalAuditorConfig): { model: Model<any> | undefined; error?: string } {
	if (!config.model && !config.provider) return { model: ctx.model };
	if (config.provider && config.model) {
		const model = ctx.modelRegistry.find(config.provider, config.model);
		return model ? { model } : { model: undefined, error: `Configured auditor model not found: ${config.provider}/${config.model}` };
	}
	if (config.provider) {
		const matches = ctx.modelRegistry.getAvailable().filter((model) => model.provider === config.provider);
		return matches[0] ? { model: matches[0] } : { model: undefined, error: `No available auditor model for provider: ${config.provider}` };
	}
	if (!config.model) return { model: ctx.model };
	const slash = config.model.indexOf("/");
	if (slash > 0) {
		const provider = config.model.slice(0, slash);
		const modelId = config.model.slice(slash + 1);
		const model = ctx.modelRegistry.find(provider, modelId);
		return model ? { model } : { model: undefined, error: `Configured auditor model not found: ${config.model}` };
	}
	const matches = ctx.modelRegistry.getAvailable().filter((model) => model.id === config.model || model.name === config.model);
	if (matches.length === 1) return { model: matches[0] };
	return { model: undefined, error: `Configured auditor model is ambiguous or unavailable: ${config.model}` };
}

function modelLabel(model: Model<any> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

export async function runGoalCompletionAuditor(args: {
	ctx: ExtensionContext;
	goal: GoalRecord;
	completionSummary?: string | null;
	detailedSummary: string;
	signal?: AbortSignal;
	/** Optional live-progress sink. Callers forward this to the parent tool's onUpdate. */
	onProgress?: (event: GoalAuditorProgressEvent) => void;
}): Promise<GoalAuditorResult> {
	const config = loadGoalAuditorConfig(args.ctx.cwd);
	const resolved = resolveAuditorModel(args.ctx, config);
	const model = resolved.model;
	const thinkingLevel = config.thinkingLevel;
	const outputParts: string[] = [];
	const emit = (event: GoalAuditorProgressEvent) => {
		try {
			args.onProgress?.(event);
		} catch {
			// Progress relay must never break the audit.
		}
	};
	if (resolved.error) {
		return { approved: false, disapproved: true, output: "", model: modelLabel(model), thinkingLevel, error: resolved.error };
	}
	try {
		const { session } = await createAgentSession({
			cwd: args.ctx.cwd,
			model,
			thinkingLevel,
			modelRegistry: args.ctx.modelRegistry,
			resourceLoader: makeAuditorResourceLoader(),
			sessionManager: SessionManager.inMemory(args.ctx.cwd),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			tools: ["read", "grep", "find", "ls", "bash"],
		});
		// Relay auditor activity to the parent UI and let the parent abort
		// interrupt the auditor loop promptly.
		const onAbort = () => {
			try {
				void session.abort();
			} catch {
				// Abort is best-effort.
			}
		};
		args.signal?.addEventListener("abort", onAbort, { once: true });
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				emit({ kind: "tool_start", toolName: event.toolName, args: event.args });
				return;
			}
			if (event.type === "tool_execution_end") {
				emit({ kind: "tool_end", toolName: event.toolName, isError: event.isError });
				return;
			}
			if (event.type !== "message_end") return;
			const message = event.message as any;
			if (message.role !== "assistant") return;
			let textParts = "";
			for (const part of message.content ?? []) {
				if (part.type === "text" && typeof part.text === "string") {
					outputParts.push(part.text);
					textParts += `${textParts ? "\n" : ""}${part.text}`;
				}
			}
			if (textParts.trim()) emit({ kind: "assistant_text", text: textParts });
		});
		try {
			if (args.signal?.aborted) return { approved: false, disapproved: true, output: "", model: modelLabel(model), thinkingLevel, error: "Auditor aborted." };
			await session.prompt(buildGoalAuditorPrompt(args));
		} finally {
			unsubscribe();
			args.signal?.removeEventListener("abort", onAbort);
		}
		const output = outputParts.join("\n\n").trim();
		const decision = parseAuditorDecision(output);
		return { ...decision, output, model: modelLabel(model), thinkingLevel };
	} catch (error) {
		return {
			approved: false,
			disapproved: true,
			output: outputParts.join("\n\n").trim(),
			model: modelLabel(model),
			thinkingLevel,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
