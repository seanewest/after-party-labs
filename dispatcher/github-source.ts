import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  extractSignedAgent,
  feedbackSourceKey,
  type GitHubFeedbackEvent,
  type GitHubFeedbackKind,
  type GitHubFeedbackPage,
  type GitHubFeedbackSource,
  type PullRequestRoute,
} from "./github-feedback.ts";
import type {
  GitHubContinuationSource,
  PullRequestCheck,
  PullRequestTransitionState,
} from "./github-continuation.ts";
import { isAgentName, type AgentName } from "./registry.ts";

const execFileAsync = promisify(execFile);

export type GhCommandRunner = (arguments_: string[]) => Promise<string>;
export type Delay = (milliseconds: number) => Promise<void>;

export interface GhCliGitHubSourceOptions {
  owner: string;
  projectNumber: number;
  run?: GhCommandRunner;
  delay?: Delay;
  maxAttempts?: number;
  baseDelayMs?: number;
}

type JsonObject = Record<string, unknown>;

export class GhCliGitHubSource
  implements GitHubFeedbackSource, GitHubContinuationSource
{
  #owner: string;
  #projectNumber: number;
  #run: GhCommandRunner;
  #delay: Delay;
  #maxAttempts: number;
  #baseDelayMs: number;

  constructor(options: GhCliGitHubSourceOptions) {
    this.#owner = nonEmpty(options.owner, "project owner");
    this.#projectNumber = positiveInteger(
      options.projectNumber,
      "project number",
    );
    this.#run = options.run ?? runGh;
    this.#delay = options.delay ?? delay;
    this.#maxAttempts = positiveInteger(
      options.maxAttempts ?? 3,
      "maximum attempts",
    );
    this.#baseDelayMs = positiveInteger(
      options.baseDelayMs ?? 500,
      "base retry delay",
    );
  }

  async discoverPullRequestRoutes(): Promise<PullRequestRoute[]> {
    const output = await this.#runWithRetry([
      "project",
      "item-list",
      String(this.#projectNumber),
      "--owner",
      this.#owner,
      "--limit",
      "1000",
      "--format",
      "json",
    ]);
    const document = parseObject(output, "project item list");
    const items = arrayValue(document.items, "project items");
    const totalCount = optionalPositiveInteger(document.totalCount);
    if (totalCount && totalCount > items.length) {
      throw new Error(
        `Project item discovery reached its 1000-item safety limit (${items.length} of ${totalCount}).`,
      );
    }
    const routes: PullRequestRoute[] = [];

    for (const itemValue of items) {
      const item = objectValue(itemValue, "project item");
      const content = optionalObject(item.content);
      if (!content || content.type !== "Issue") {
        continue;
      }
      const status = optionalString(fieldValue(item, "Status"));
      if (status !== "In Progress" && status !== "Review") {
        continue;
      }
      const repository = optionalString(content.repository);
      const taskNumber = optionalPositiveInteger(content.number);
      const taskUrl = optionalString(content.url);
      if (!repository || !taskNumber || !taskUrl) {
        continue;
      }
      const workType = optionalString(fieldValue(item, "Work Type"));
      const agentValue = optionalString(fieldValue(item, "Original Agent"));
      const implementingAgent = parseOptionalAgent(agentValue);
      const links = fieldValue(item, "Linked pull requests");
      if (!Array.isArray(links)) {
        continue;
      }

      for (const link of links) {
        if (typeof link !== "string") {
          continue;
        }
        const parsed = parsePullRequestUrl(link);
        if (!parsed) {
          continue;
        }
        routes.push({
          repository: parsed.repository,
          pullRequestNumber: parsed.number,
          pullRequestUrl: link,
          taskNumber,
          taskUrl,
          taskTitle: optionalString(content.title) ?? `Task #${taskNumber}`,
          workType,
          status,
          implementingAgent,
        });
      }
    }
    return routes;
  }

  async listFeedbackPage(
    route: PullRequestRoute,
    kind: GitHubFeedbackKind,
    page: number,
    perPage: number,
  ): Promise<GitHubFeedbackPage> {
    const endpoint = feedbackEndpoint(route, kind);
    const output = await this.#runWithRetry([
      "api",
      "--method",
      "GET",
      endpoint,
      "-f",
      `per_page=${positiveInteger(perPage, "page size")}`,
      "-f",
      `page=${positiveInteger(page, "page number")}`,
    ]);
    const values = parseArray(output, `${kind} page`);
    const events = values.flatMap((value) => {
      try {
        return [normalizeFeedback(route, kind, objectValue(value, kind))];
      } catch {
        // One deleted or partially inaccessible object must not hide later events.
        return [];
      }
    });
    return {
      events,
      hasNextPage: values.length === perPage,
    };
  }

  async getPullRequestTransitionState(
    repository: string,
    pullRequestNumber: number,
  ): Promise<PullRequestTransitionState> {
    const targetRepository = repositoryName(repository);
    const targetNumber = positiveInteger(
      pullRequestNumber,
      "pull request number",
    );
    const output = await this.#runWithRetry([
      "pr",
      "view",
      String(targetNumber),
      "--repo",
      targetRepository,
      "--json",
      "headRefOid,state,mergedAt,statusCheckRollup,url",
    ]);
    const document = parseObject(output, "pull request transition state");
    const state = requiredString(document.state, "pull request state").toUpperCase();
    return {
      repository: targetRepository,
      pullRequestNumber: targetNumber,
      url: requiredString(document.url, "pull request URL"),
      head: requiredString(document.headRefOid, "pull request head"),
      open: state === "OPEN",
      merged: state === "MERGED" || optionalString(document.mergedAt) !== null,
      checks: arrayValue(
        document.statusCheckRollup,
        "pull request check rollup",
      ).map(normalizeCheck),
    };
  }

  async #runWithRetry(arguments_: string[]): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        return await this.#run(arguments_);
      } catch (error) {
        lastError = error;
        if (attempt === this.#maxAttempts || !isTransientGitHubError(error)) {
          throw error;
        }
        await this.#delay(this.#baseDelayMs * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }
}

function normalizeCheck(value: unknown): PullRequestCheck {
  const check = objectValue(value, "pull request check");
  const typeName = optionalString(check.__typename);
  if (typeName === "CheckRun" || check.status !== undefined) {
    const status = requiredString(check.status, "check run status").toUpperCase();
    return {
      name:
        optionalString(check.name) ??
        optionalString(check.workflowName) ??
        "unnamed check run",
      completed: status === "COMPLETED",
      result: optionalString(check.conclusion)?.toUpperCase() ?? null,
    };
  }

  const state = requiredString(check.state, "status context state").toUpperCase();
  return {
    name:
      optionalString(check.context) ??
      optionalString(check.name) ??
      "unnamed status context",
    completed: ["SUCCESS", "FAILURE", "ERROR"].includes(state),
    result: state,
  };
}

export async function runGh(arguments_: string[]): Promise<string> {
  const result = await execFileAsync("gh", arguments_, {
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

export function isTransientGitHubError(error: unknown): boolean {
  const details = errorDetails(error);
  return /(?:rate.?limit|secondary rate|HTTP\s+(?:429|5\d\d)|\b(?:429|500|502|503|504)\b|temporar|timed?\s*out|timeout|connection\s+(?:reset|closed)|ECONNRESET|ETIMEDOUT)/i.test(
    details,
  );
}

function feedbackEndpoint(
  route: PullRequestRoute,
  kind: GitHubFeedbackKind,
): string {
  const base = `repos/${route.repository}`;
  if (kind === "review") {
    return `${base}/pulls/${route.pullRequestNumber}/reviews`;
  }
  if (kind === "review_comment") {
    return `${base}/pulls/${route.pullRequestNumber}/comments`;
  }
  return `${base}/issues/${route.pullRequestNumber}/comments`;
}

function normalizeFeedback(
  route: PullRequestRoute,
  kind: GitHubFeedbackKind,
  value: JsonObject,
): GitHubFeedbackEvent {
  const id = requiredScalar(value.id, "feedback ID");
  const body = optionalString(value.body) ?? "";
  const createdAt = requiredString(
    kind === "review" ? value.submitted_at : value.created_at,
    "feedback creation time",
  );
  const url = requiredString(value.html_url, "feedback URL");
  return {
    sourceId: `github:${route.repository}:pull:${route.pullRequestNumber}:${kind}:${id}`,
    sourceKey: feedbackSourceKey(route, kind),
    kind,
    repository: route.repository,
    pullRequestNumber: route.pullRequestNumber,
    url,
    body,
    reviewState:
      kind === "review"
        ? (optionalString(value.state)?.toUpperCase() ?? null)
        : null,
    threadId:
      kind === "review_comment"
        ? requiredScalar(value.in_reply_to_id ?? value.id, "review thread ID")
        : null,
    actorAgent: extractSignedAgent(body),
    createdAt,
  };
}

function parsePullRequestUrl(
  value: string,
): { repository: string; number: number } | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/.exec(
    value,
  );
  if (!match) {
    return null;
  }
  return {
    repository: match[1],
    number: Number(match[2]),
  };
}

function repositoryName(value: string): string {
  const normalized = value.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    throw new Error("repository must use the OWNER/REPOSITORY form.");
  }
  return normalized;
}

function fieldValue(item: JsonObject, fieldName: string): unknown {
  const target = fieldName.toLowerCase();
  return Object.entries(item).find(([name]) => name.toLowerCase() === target)?.[1];
}

function parseOptionalAgent(value: string | null): AgentName | null {
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  return isAgentName(normalized) ? normalized : null;
}

function parseObject(value: string, label: string): JsonObject {
  try {
    return objectValue(JSON.parse(value), label);
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${errorDetails(error)}`);
  }
}

function parseArray(value: string, label: string): unknown[] {
  try {
    return arrayValue(JSON.parse(value), label);
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${errorDetails(error)}`);
  }
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function optionalObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  const parsed = optionalString(value);
  if (!parsed) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return parsed;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredScalar(value: unknown, label: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).trim() === ""
  ) {
    throw new Error(`${label} must be a string or number.`);
  }
  return String(value);
}

function optionalPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty.`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function errorDetails(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }
  const value = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
  return [value.message, value.stderr, value.stdout]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
