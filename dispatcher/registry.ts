export const AGENT_NAMES = [
  "beavis",
  "butthead",
  "cornholio",
  "daria",
  "morpheus",
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

const agentNames = new Set<string>(AGENT_NAMES);

export function parseAgentName(value: string): AgentName {
  const normalized = value.trim().toLowerCase();
  if (!agentNames.has(normalized)) {
    throw new Error(
      `Unknown agent "${value}". Expected one of: ${AGENT_NAMES.join(", ")}.`,
    );
  }

  return normalized as AgentName;
}

export function isAgentName(value: string): value is AgentName {
  return agentNames.has(value);
}
