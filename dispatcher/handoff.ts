import type { JsonValue, QueueMessage } from "./queue.ts";
import { parseAgentName, type AgentName } from "./registry.ts";

export const HANDOFF_VERSION = 1;
export const HANDOFF_PREFIX = "[AFTER_PARTY_HANDOFF_V1:";

export interface HandoffEnvelope {
  version: 1;
  messageId: string;
  sender: AgentName;
  recipient: AgentName;
  attempt: number;
}

export interface ParsedHandoff {
  envelope: HandoffEnvelope;
  body: string;
}

export function formatHandoff(message: QueueMessage): string {
  const envelope: HandoffEnvelope = {
    version: HANDOFF_VERSION,
    messageId: message.id,
    sender: message.sender,
    recipient: message.recipient,
    attempt: message.attemptCount,
  };
  const encoded = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  return `${HANDOFF_PREFIX}${encoded}]\n${payloadText(message.payload)}`;
}

export function parseHandoff(prompt: string): ParsedHandoff | null {
  const newline = prompt.indexOf("\n");
  const header = newline === -1 ? prompt : prompt.slice(0, newline);
  if (!header.startsWith(HANDOFF_PREFIX) || !header.endsWith("]")) {
    return null;
  }
  const encoded = header.slice(HANDOFF_PREFIX.length, -1);
  try {
    const raw = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as
      | Record<string, unknown>
      | null;
    if (
      !raw ||
      raw.version !== HANDOFF_VERSION ||
      typeof raw.messageId !== "string" ||
      !raw.messageId.trim() ||
      typeof raw.sender !== "string" ||
      typeof raw.recipient !== "string" ||
      !Number.isSafeInteger(raw.attempt) ||
      Number(raw.attempt) < 1
    ) {
      return null;
    }
    return {
      envelope: {
        version: HANDOFF_VERSION,
        messageId: raw.messageId,
        sender: parseAgentName(raw.sender),
        recipient: parseAgentName(raw.recipient),
        attempt: Number(raw.attempt),
      },
      body: newline === -1 ? "" : prompt.slice(newline + 1),
    };
  } catch {
    return null;
  }
}

function payloadText(payload: JsonValue): string {
  if (
    payload !== null &&
    !Array.isArray(payload) &&
    typeof payload === "object" &&
    typeof payload.text === "string"
  ) {
    return payload.text;
  }
  return JSON.stringify(payload, null, 2);
}
