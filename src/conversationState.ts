import type { Env } from "./env";

export interface IntakePet {
  id: string;
  name: string;
  species: string | null;
}

export interface IntakeMessage {
  direction: "inbound" | "outbound" | "system";
  content: string;
  createdAt: string;
}

export interface ConversationIntakeContext {
  conversationId: string;
  clinicId: string;
  ownerId: string;
  petId: string | null;
  status: "active" | "handoff" | "completed";
  intakeStage: IntakeStage;
  intakeData: Record<string, unknown>;
  stateVersion: number;
  ownerName: string;
  pets: IntakePet[];
  recentMessages: IntakeMessage[];
}

export type ContextResult =
  | { ok: true; context: ConversationIntakeContext }
  | { ok: false; reason: "not_found" | "failed" };

export interface AdvanceConversationIntakeInput {
  conversationId: string;
  expectedVersion: number;
  nextStage: IntakeStage;
  petId: string | null;
  intakeData: Record<string, unknown>;
}

export type AdvanceResult =
  | { ok: true; intakeStage: IntakeStage; stateVersion: number }
  | { ok: false; reason: "stale" | "failed" };

export type IntakeStage =
  | "pet_identification"
  | "complaint_collection"
  | "intake_confirmation"
  | "safety_check"
  | "ready_for_triage"
  | "appointment_offer"
  | "appointment_selection"
  | "appointment_confirmation"
  | "human_handoff"
  | "completed";

const INTAKE_STAGES = new Set<IntakeStage>([
  "pet_identification",
  "complaint_collection",
  "intake_confirmation",
  "safety_check",
  "ready_for_triage",
  "appointment_offer",
  "appointment_selection",
  "appointment_confirmation",
  "human_handoff",
  "completed",
]);

function isIntakeStage(value: unknown): value is IntakeStage {
  return typeof value === "string" && INTAKE_STAGES.has(value as IntakeStage);
}

function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

function buildEndpoint(env: Env, rpcName: string): URL | null {
  if (!env.SUPABASE_URL.trim() || !env.SUPABASE_SERVICE_ROLE_KEY.trim()) {
    return null;
  }
  let endpoint: URL;
  try {
    endpoint = new URL(`/rest/v1/rpc/${rpcName}`, env.SUPABASE_URL);
  } catch {
    return null;
  }
  if (endpoint.protocol !== "https:" && !isLoopbackHttpUrl(endpoint)) {
    return null;
  }
  return endpoint;
}

async function callRpc(endpoint: URL, env: Env, body: Record<string, unknown>): Promise<unknown[] | null> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }

  return Array.isArray(payload) ? payload : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parsePet(value: unknown): IntakePet | null {
  const row = asRecord(value);
  if (!row) return null;
  const { id, name, species } = row;
  if (typeof id !== "string" || typeof name !== "string") return null;
  if (species !== null && typeof species !== "string") return null;
  return { id, name, species };
}

function parseMessage(value: unknown): IntakeMessage | null {
  const row = asRecord(value);
  if (!row) return null;
  const { direction, content, created_at: createdAt } = row;
  if (direction !== "inbound" && direction !== "outbound" && direction !== "system") return null;
  if (typeof content !== "string" || typeof createdAt !== "string") return null;
  return { direction, content, createdAt };
}

function parseContextRow(value: unknown): ConversationIntakeContext | null {
  const row = asRecord(value);
  if (!row) return null;

  const conversationId = row.conversation_id;
  const clinicId = row.clinic_id;
  const ownerId = row.owner_id;
  const petId = row.pet_id;
  const status = row.status;
  const intakeStage = row.intake_stage;
  const intakeData = row.intake_data;
  const stateVersion = row.state_version;
  const ownerName = row.owner_name;
  const pets = row.pets;
  const recentMessages = row.recent_messages;

  if (typeof conversationId !== "string" || typeof clinicId !== "string" || typeof ownerId !== "string") return null;
  if (petId !== null && typeof petId !== "string") return null;
  if (status !== "active" && status !== "handoff" && status !== "completed") return null;
  if (!isIntakeStage(intakeStage)) return null;
  const intakeDataRecord = asRecord(intakeData);
  if (!intakeDataRecord) return null;
  if (typeof stateVersion !== "number" || !Number.isInteger(stateVersion) || stateVersion < 1) return null;
  if (typeof ownerName !== "string") return null;
  if (!Array.isArray(pets) || !Array.isArray(recentMessages)) return null;

  const parsedPets = pets.map(parsePet);
  if (parsedPets.some((pet) => pet === null)) return null;

  const parsedMessages = recentMessages.map(parseMessage);
  if (parsedMessages.some((message) => message === null)) return null;

  return {
    conversationId,
    clinicId,
    ownerId,
    petId,
    status,
    intakeStage,
    intakeData: intakeDataRecord,
    stateVersion,
    ownerName,
    pets: parsedPets as IntakePet[],
    recentMessages: parsedMessages as IntakeMessage[],
  };
}

/** Calls the `get_conversation_intake_context` Data API RPC over native fetch. Never logs the request/response body. */
export async function getConversationIntakeContext(conversationId: string, env: Env): Promise<ContextResult> {
  const endpoint = buildEndpoint(env, "get_conversation_intake_context");
  if (!endpoint) return { ok: false, reason: "failed" };

  const rows = await callRpc(endpoint, env, { p_conversation_id: conversationId });
  if (rows === null) return { ok: false, reason: "failed" };
  if (rows.length === 0) return { ok: false, reason: "not_found" };
  if (rows.length !== 1) return { ok: false, reason: "failed" };

  const context = parseContextRow(rows[0]);
  if (!context) return { ok: false, reason: "failed" };

  return { ok: true, context };
}

/** Calls the `advance_conversation_intake` Data API RPC over native fetch. Never logs the request/response body. */
export async function advanceConversationIntake(input: AdvanceConversationIntakeInput, env: Env): Promise<AdvanceResult> {
  const endpoint = buildEndpoint(env, "advance_conversation_intake");
  if (!endpoint) return { ok: false, reason: "failed" };

  const rows = await callRpc(endpoint, env, {
    p_conversation_id: input.conversationId,
    p_expected_version: input.expectedVersion,
    p_next_stage: input.nextStage,
    p_pet_id: input.petId,
    p_intake_data: input.intakeData,
  });
  if (rows === null) return { ok: false, reason: "failed" };
  if (rows.length === 0) return { ok: false, reason: "stale" };
  if (rows.length !== 1) return { ok: false, reason: "failed" };

  const row = asRecord(rows[0]);
  const intakeStage = row?.intake_stage;
  const stateVersion = row?.state_version;
  if (!isIntakeStage(intakeStage) || typeof stateVersion !== "number" || !Number.isInteger(stateVersion) || stateVersion < 1) {
    return { ok: false, reason: "failed" };
  }

  return { ok: true, intakeStage, stateVersion };
}
