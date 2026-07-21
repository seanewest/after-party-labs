import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  GoalContextStore,
  type GoalContextRecord,
} from "./goal-context.ts";
import type { JsonValue } from "./queue.ts";

const execFileAsync = promisify(execFile);

export const GOAL_BOARD_STATES = [
  "Backlog",
  "Ready",
  "In Progress",
  "Human Needed",
  "Done",
] as const;

export type GoalBoardState = (typeof GOAL_BOARD_STATES)[number];

export interface BoardGoal {
  itemId: string;
  repository: string;
  issueNumber: number;
  title: string;
  url: string;
  state: GoalBoardState;
  contextId: string | null;
  contextUrl: string | null;
  linkedPullRequests: string[];
}

export interface GoalSourceEvent {
  sourceId: string;
  sourceKind: string;
  sourceVersion: string;
  sourceTime: number;
  payload: JsonValue;
}

export interface GoalGitHubSource {
  listGoals(): Promise<BoardGoal[]>;
  listEvents(goal: BoardGoal): Promise<GoalSourceEvent[]>;
  recordContext(goal: BoardGoal, context: GoalContextRecord): Promise<void>;
}

export type GoalCommandRunner = (arguments_: string[]) => Promise<string>;

export interface GhProjectGoalSourceOptions {
  owner: string;
  projectNumber: number;
  run?: GoalCommandRunner;
  now?: () => number;
}

type JsonObject = Record<string, unknown>;

export class GhProjectGoalSource implements GoalGitHubSource {
  #owner: string;
  #projectNumber: number;
  #run: GoalCommandRunner;
  #now: () => number;

  constructor(options: GhProjectGoalSourceOptions) {
    this.#owner = nonEmpty(options.owner, "project owner");
    this.#projectNumber = positiveInteger(options.projectNumber, "project number");
    this.#run = options.run ?? runGh;
    this.#now = options.now ?? Date.now;
  }

  async listGoals(): Promise<BoardGoal[]> {
    const output = await this.#run([
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
    const document = object(JSON.parse(output), "project items");
    const values = array(document.items, "project items");
    return values.flatMap((value) => {
      try {
        const item = object(value, "project item");
        const content = object(item.content, "project item content");
        if (content.type !== "Issue") {
          return [];
        }
        const rawState = optionalString(field(item, "Goal Status")) ??
          optionalString(field(item, "Status"));
        const state = normalizeBoardState(rawState);
        if (!state) {
          return [];
        }
        const repository = requiredString(content.repository, "goal repository");
        const issueNumber = positiveInteger(
          number(content.number, "goal issue number"),
          "goal issue number",
        );
        const links = field(item, "Linked pull requests");
        return [{
          itemId: requiredString(item.id, "project item ID"),
          repository,
          issueNumber,
          title: requiredString(content.title, "goal title"),
          url: requiredString(content.url, "goal URL"),
          state,
          contextId: optionalString(field(item, "Goal Context ID")),
          contextUrl: optionalString(field(item, "Context URL")),
          linkedPullRequests: Array.isArray(links)
            ? links.filter((link): link is string => typeof link === "string")
            : [],
        }];
      } catch {
        return [];
      }
    });
  }

  async listEvents(goal: BoardGoal): Promise<GoalSourceEvent[]> {
    const issue = object(
      JSON.parse(
        await this.#run([
          "issue",
          "view",
          String(goal.issueNumber),
          "--repo",
          goal.repository,
          "--json",
          "title,url,state,updatedAt",
        ]),
      ),
      "goal issue snapshot",
    );
    const events = [snapshotEvent("issue_snapshot", goal, issue, this.#now())];
    events.push(
      ...(await this.#apiEvents(
        goal,
        "issue_comment",
        `repos/${goal.repository}/issues/${goal.issueNumber}/comments`,
      )),
    );
    for (const link of goal.linkedPullRequests) {
      const parsed = parsePullRequestUrl(link);
      if (!parsed || parsed.repository.toLowerCase() !== goal.repository.toLowerCase()) {
        continue;
      }
      const pullMetadata = object(
        JSON.parse(await this.#run([
          "api", "--method", "GET",
          `repos/${parsed.repository}/pulls/${parsed.number}`,
        ])),
        "linked pull request metadata",
      );
      const base = object(pullMetadata.base, "linked pull request base");
      const baseRepository = object(base.repo, "linked pull request base repository");
      if (
        !isTrustedAssociation(pullMetadata.author_association) ||
        optionalString(baseRepository.full_name)?.toLowerCase() !== goal.repository.toLowerCase()
      ) {
        continue;
      }
      const pullRequest = object(
        JSON.parse(
          await this.#run([
            "pr",
            "view",
            String(parsed.number),
            "--repo",
            parsed.repository,
          "--json",
          "url,state,updatedAt,mergedAt,headRefOid,statusCheckRollup",
          ]),
        ),
        "goal pull request snapshot",
      );
      events.push(
        snapshotEvent(
          "pull_request_snapshot",
          goal,
          { repository: parsed.repository, number: parsed.number, ...pullRequest },
          this.#now(),
        ),
      );
      const head = optionalString(pullRequest.headRefOid);
      if (head) {
        const deployments = await this.#apiEvents(
          goal,
          "deployment",
          `repos/${parsed.repository}/deployments`,
          ["-f", `ref=${head}`],
        );
        events.push(...deployments);
        for (const deployment of deployments) {
          const id = object(deployment.payload, "deployment payload").id;
          if (typeof id === "number" || typeof id === "string") {
            events.push(...await this.#apiEvents(
              goal,
              "deployment_status",
              `repos/${parsed.repository}/deployments/${String(id)}/statuses`,
            ));
          }
        }
      }
      events.push(
        ...(await this.#apiEvents(
          goal,
          "pull_request_conversation_comment",
          `repos/${parsed.repository}/issues/${parsed.number}/comments`,
        )),
        ...(await this.#apiEvents(
          goal,
          "pull_request_review",
          `repos/${parsed.repository}/pulls/${parsed.number}/reviews`,
        )),
        ...(await this.#apiEvents(
          goal,
          "pull_request_review_comment",
          `repos/${parsed.repository}/pulls/${parsed.number}/comments`,
        )),
      );
    }
    return events;
  }

  async #apiEvents(
    goal: BoardGoal,
    kind: string,
    endpoint: string,
    extraArguments: string[] = [],
  ): Promise<GoalSourceEvent[]> {
    const output = await this.#run([
      "api", "--method", "GET", endpoint, "-f", "per_page=100",
      ...extraArguments, "--paginate", "--slurp",
    ]);
    const pages = array(JSON.parse(output), `${kind} pages`);
    return pages.flatMap((page) => array(page, `${kind} page`)).flatMap((value) => {
      try {
        const payload = object(value, kind);
        if (isInteractiveEvent(kind) && !isTrustedAssociation(payload.author_association)) {
          return [];
        }
        const id = String(payload.id ?? payload.node_id ?? "").trim();
        if (!id) return [];
        const canonical = stableJson(payload);
        const version = createHash("sha256").update(canonical).digest("hex");
        const timeValue = optionalString(payload.updated_at) ?? optionalString(payload.created_at);
        const sourceTime = timeValue ? Date.parse(timeValue) : this.#now();
        return [{
          sourceId: `github:${goal.repository}:${kind}:${id}:${version}`,
          sourceKind: kind,
          sourceVersion: version,
          sourceTime: Number.isFinite(sourceTime) ? sourceTime : this.#now(),
          payload: JSON.parse(canonical) as JsonValue,
        }];
      } catch {
        return [];
      }
    });
  }

  async recordContext(goal: BoardGoal, context: GoalContextRecord): Promise<void> {
    const fields = await this.#ensureFields();
    const project = object(
      JSON.parse(
        await this.#run([
          "project",
          "view",
          String(this.#projectNumber),
          "--owner",
          this.#owner,
          "--format",
          "json",
        ]),
      ),
      "project",
    );
    const projectId = requiredString(project.id, "project ID");
    await this.#editText(projectId, goal.itemId, fields.contextId.id, context.id);
    if (context.contextUrl) {
      await this.#editText(projectId, goal.itemId, fields.contextUrl.id, context.contextUrl);
    }
    const inProgress = fields.goalStatus.options.find(
      (option) => option.name === "In Progress",
    );
    if (!inProgress) {
      throw new Error("Goal Status field has no In Progress option.");
    }
    await this.#run([
      "project",
      "item-edit",
      "--id",
      goal.itemId,
      "--project-id",
      projectId,
      "--field-id",
      fields.goalStatus.id,
      "--single-select-option-id",
      inProgress.id,
    ]);
  }

  async #ensureFields(): Promise<{
    contextId: Field;
    contextUrl: Field;
    goalStatus: SelectField;
  }> {
    let fields = await this.#fields();
    if (!fields.find((value) => value.name === "Goal Context ID")) {
      await this.#run([
        "project", "field-create", String(this.#projectNumber), "--owner", this.#owner,
        "--name", "Goal Context ID", "--data-type", "TEXT", "--format", "json",
      ]);
    }
    if (!fields.find((value) => value.name === "Context URL")) {
      await this.#run([
        "project", "field-create", String(this.#projectNumber), "--owner", this.#owner,
        "--name", "Context URL", "--data-type", "TEXT", "--format", "json",
      ]);
    }
    if (!fields.find((value) => value.name === "Goal Status")) {
      await this.#run([
        "project", "field-create", String(this.#projectNumber), "--owner", this.#owner,
        "--name", "Goal Status", "--data-type", "SINGLE_SELECT",
        "--single-select-options", GOAL_BOARD_STATES.join(","), "--format", "json",
      ]);
    }
    fields = await this.#fields();
    const contextId = fields.find((value) => value.name === "Goal Context ID");
    const contextUrl = fields.find((value) => value.name === "Context URL");
    const goalStatus = fields.find((value) => value.name === "Goal Status");
    if (!contextId || !contextUrl || !goalStatus || !("options" in goalStatus)) {
      throw new Error("Could not create the goal-context project fields.");
    }
    return { contextId, contextUrl, goalStatus: goalStatus as SelectField };
  }

  async #fields(): Promise<Array<Field | SelectField>> {
    const output = await this.#run([
      "project", "field-list", String(this.#projectNumber), "--owner", this.#owner,
      "--format", "json",
    ]);
    const document = object(JSON.parse(output), "project fields");
    return array(document.fields, "project fields").map((value) => {
      const fieldValue = object(value, "project field");
      const basic: Field = {
        id: requiredString(fieldValue.id, "project field ID"),
        name: requiredString(fieldValue.name, "project field name"),
      };
      return Array.isArray(fieldValue.options)
        ? {
            ...basic,
            options: fieldValue.options.map((optionValue) => {
              const option = object(optionValue, "project field option");
              return {
                id: requiredString(option.id, "project option ID"),
                name: requiredString(option.name, "project option name"),
              };
            }),
          }
        : basic;
    });
  }

  async #editText(
    projectId: string,
    itemId: string,
    fieldId: string,
    value: string,
  ): Promise<void> {
    await this.#run([
      "project", "item-edit", "--id", itemId, "--project-id", projectId,
      "--field-id", fieldId, "--text", value,
    ]);
  }
}

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function isInteractiveEvent(kind: string): boolean {
  return kind.includes("comment") || kind === "pull_request_review";
}

function isTrustedAssociation(value: unknown): boolean {
  return typeof value === "string" && TRUSTED_ASSOCIATIONS.has(value.toUpperCase());
}

interface Field { id: string; name: string }
interface SelectField extends Field { options: Array<{ id: string; name: string }> }

export interface GoalGitHubPollerOptions {
  provision?: (goal: BoardGoal) => Promise<GoalContextRecord | null>;
}

export interface GoalGitHubPollResult {
  goals: number;
  provisioned: number;
  recorded: number;
  duplicates: number;
  skipped: number;
  discoveryFailed: boolean;
  deferredUntil: number | null;
  failures: Array<{ goal: string; error: string }>;
}

export class GoalGitHubPoller {
  #source: GoalGitHubSource;
  #store: GoalContextStore;
  #provision?: (goal: BoardGoal) => Promise<GoalContextRecord | null>;
  #owner = `goal-poller:${process.pid}:${randomUUID()}`;

  constructor(
    source: GoalGitHubSource,
    store: GoalContextStore,
    options: GoalGitHubPollerOptions = {},
  ) {
    this.#source = source;
    this.#store = store;
    this.#provision = options.provision;
  }

  async poll(): Promise<GoalGitHubPollResult> {
    const result: GoalGitHubPollResult = {
      goals: 0,
      provisioned: 0,
      recorded: 0,
      duplicates: 0,
      skipped: 0,
      discoveryFailed: false,
      deferredUntil: null,
      failures: [],
    };
    let goals: BoardGoal[];
    try {
      goals = await this.#source.listGoals();
    } catch (error) {
      result.discoveryFailed = true;
      result.failures.push({
        goal: "project-discovery",
        error: error instanceof Error ? error.message : String(error),
      });
      return result;
    }
    for (const goal of goals) {
      result.goals += 1;
      try {
        let context = this.#store.getByGoal(goal);
        if (!context && this.#provision && ["Ready", "In Progress"].includes(goal.state)) {
          context = await this.#provision(goal);
          if (context) {
            result.provisioned += 1;
            await this.#recordContext(goal, context);
          }
        }
        if (!context) {
          result.skipped += 1;
          continue;
        }
        if (goal.state === "Human Needed" && context.state !== "human_needed") {
          context = this.#store.updateRuntime(context.id, { state: "human_needed" });
        } else if (["Backlog", "Done"].includes(goal.state)) {
          if (context.state !== "stopped") {
            context = this.#store.updateRuntime(context.id, { state: "stopped" });
          }
          continue;
        } else if (["Ready", "In Progress"].includes(goal.state) &&
          ["stopped", "human_needed"].includes(context.state)) {
          context = this.#store.updateRuntime(context.id, { state: "sleeping" });
        }
        if (
          ["Ready", "In Progress"].includes(goal.state) &&
          (goal.contextId !== context.id || goal.contextUrl !== context.contextUrl)
        ) {
          await this.#recordContext(goal, context);
        }
        for (const event of await this.#source.listEvents(goal)) {
          const before = this.#store.listEvents(context.id).find(
            (value) => value.sourceId === event.sourceId,
          );
          this.#store.enqueueEvent({ contextId: context.id, ...event });
          before ? (result.duplicates += 1) : (result.recorded += 1);
        }
      } catch (error) {
        result.failures.push({
          goal: `${goal.repository}#${goal.issueNumber}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  async #recordContext(goal: BoardGoal, context: GoalContextRecord): Promise<void> {
    const lock = "github-project-context-fields";
    if (!this.#store.tryAcquireCoordinationLock(lock, this.#owner, 60_000)) {
      return;
    }
    try {
      await this.#source.recordContext(goal, context);
    } finally {
      this.#store.releaseCoordinationLock(lock, this.#owner);
    }
  }
}

export function isTransientGitHubFailure(message: string): boolean {
  return /graphql|rate.?limit|capacity|timeout|timed out|temporar|try again|unknown owner type|HTTP 5\d\d|ECONN|ENET|EAI_AGAIN/i
    .test(message);
}

export function boundedGitHubBackoff(
  consecutiveFailures: number,
  baseMs = 5_000,
  maximumMs = 300_000,
): number {
  if (!Number.isSafeInteger(consecutiveFailures) || consecutiveFailures < 1) {
    throw new Error("consecutive GitHub failures must be a positive integer.");
  }
  if (!Number.isSafeInteger(baseMs) || baseMs < 1 ||
    !Number.isSafeInteger(maximumMs) || maximumMs < baseMs) {
    throw new Error("GitHub backoff bounds are invalid.");
  }
  return Math.min(maximumMs, baseMs * (2 ** Math.min(consecutiveFailures - 1, 30)));
}

function snapshotEvent(
  kind: string,
  goal: BoardGoal,
  payload: JsonObject,
  now: number,
): GoalSourceEvent {
  const canonical = stableJson(payload);
  const version = createHash("sha256").update(canonical).digest("hex");
  const updatedAt = optionalString(payload.updatedAt);
  const sourceTime = updatedAt ? Date.parse(updatedAt) : now;
  return {
    sourceId: `github:${goal.repository}#${goal.issueNumber}:${kind}:${version}`,
    sourceKind: kind,
    sourceVersion: version,
    sourceTime: Number.isFinite(sourceTime) ? sourceTime : now,
    payload: JSON.parse(canonical) as JsonValue,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function field(item: JsonObject, name: string): unknown {
  if (name in item) {
    return item[name];
  }
  const camel = `${name[0].toLowerCase()}${name.slice(1)}`;
  return item[camel];
}

function normalizeBoardState(value: string | null): GoalBoardState | null {
  const migrated = value === "Waiting for Human" ? "Human Needed" : value;
  return GOAL_BOARD_STATES.includes(migrated as GoalBoardState)
    ? (migrated as GoalBoardState)
    : null;
}

function parsePullRequestUrl(value: string): { repository: string; number: number } | null {
  const match = /^https:\/\/github\.com\/(?<repository>[^/]+\/[^/]+)\/pull\/(?<number>[1-9]\d*)/.exec(value);
  return match?.groups
    ? { repository: match.groups.repository, number: Number(match.groups.number) }
    : null;
}

export async function runGh(arguments_: string[]): Promise<string> {
  const result = await execFileAsync("gh", arguments_, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new Error(`${label} must be a number.`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return nonEmpty(value, label);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
