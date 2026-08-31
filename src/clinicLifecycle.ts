import type { Env } from "./env";

// Not wired to any public route. Called only by an operator-driven pilot
// runbook (see docs/clinic-lifecycle.md), never in the request/webhook path.

export type ProvisionClinicInput = {
  clinicId: string;
  clinicName: string;
  contactPhoneE164: string | null;
  publicAddress: string | null;
  ownerUserId: string;
  staffRole: string;
  whatsappAccountId: string;
  phoneNumberId: string;
  displayName: string | null;
};

export type ProvisionClinicResult =
  | { kind: "provisioned" }
  | { kind: "already_provisioned" }
  | { kind: "call_failed" };

// Offboarding refuses suspend outright (raises, mapped to call_failed) since
// offboarding only ever moves forward to finalize; suspend's closed result
// set never includes a refused_offboarding case.
export type SuspendClinicResult = { kind: "suspended" } | { kind: "already_suspended" } | { kind: "not_found" } | { kind: "call_failed" };

export type ResumeClinicResult =
  | { kind: "resumed" }
  | { kind: "already_active" }
  | { kind: "refused_offboarding" }
  | { kind: "not_found" }
  | { kind: "call_failed" };

export type PrepareClinicOffboardingResult =
  | { kind: "prepared"; offboardingToken: string }
  | { kind: "already_offboarding"; offboardingToken: string }
  | { kind: "not_found" }
  | { kind: "call_failed" };

export type FinalizeClinicOffboardingResult =
  | { kind: "finalized" }
  | { kind: "already_offboarded" }
  | { kind: "not_found" }
  | { kind: "call_failed" };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;
const PHONE_NUMBER_ID_PATTERN = /^\d{1,64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

function failedProvision(): ProvisionClinicResult {
  return { kind: "call_failed" };
}

function failedSuspend(): SuspendClinicResult {
  return { kind: "call_failed" };
}

function failedResume(): ResumeClinicResult {
  return { kind: "call_failed" };
}

function failedPrepare(): PrepareClinicOffboardingResult {
  return { kind: "call_failed" };
}

function failedFinalize(): FinalizeClinicOffboardingResult {
  return { kind: "call_failed" };
}

function isValidText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    [...value].length >= 1 &&
    [...value].length <= maximumLength &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isValidOptionalText(value: unknown, maximumLength: number): value is string | null {
  return value === null || isValidText(value, maximumLength);
}

function isValidProvisionInput(value: unknown): value is ProvisionClinicInput {
  try {
    const input = asPlainRecord(value);
    if (!input || Reflect.ownKeys(input).length !== 9) return false;
    return (
      typeof input.clinicId === "string" &&
      UUID_PATTERN.test(input.clinicId) &&
      isValidText(input.clinicName, 200) &&
      (input.contactPhoneE164 === null ||
        (typeof input.contactPhoneE164 === "string" && E164_PATTERN.test(input.contactPhoneE164))) &&
      isValidOptionalText(input.publicAddress, 500) &&
      typeof input.ownerUserId === "string" &&
      UUID_PATTERN.test(input.ownerUserId) &&
      (input.staffRole === "admin" || input.staffRole === "veterinarian" || input.staffRole === "receptionist") &&
      typeof input.whatsappAccountId === "string" &&
      UUID_PATTERN.test(input.whatsappAccountId) &&
      typeof input.phoneNumberId === "string" &&
      PHONE_NUMBER_ID_PATTERN.test(input.phoneNumberId) &&
      isValidOptionalText(input.displayName, 200)
    );
  } catch {
    return false;
  }
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

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  try {
    return typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Calls the `provision_clinic_v1` Data API RPC over native fetch. Never logs
 * the request/response body. Provisions a clinic in the `suspended` state
 * with no AI route and no business data; see docs/clinic-lifecycle.md for
 * the full pilot activation order.
 */
export async function provisionClinic(
  input: ProvisionClinicInput,
  env: Env,
): Promise<ProvisionClinicResult> {
  let snapshot: ProvisionClinicInput;
  try {
    snapshot = { ...input };
  } catch {
    return failedProvision();
  }
  if (!isValidProvisionInput(snapshot)) return failedProvision();
  const endpoint = buildEndpoint(env, "provision_clinic_v1");
  if (!endpoint) return failedProvision();

  const rows = await callRpc(endpoint, env, {
    p_clinic_id: snapshot.clinicId,
    p_clinic_name: snapshot.clinicName,
    p_contact_phone_e164: snapshot.contactPhoneE164,
    p_public_address: snapshot.publicAddress,
    p_owner_user_id: snapshot.ownerUserId,
    p_staff_role: snapshot.staffRole,
    p_whatsapp_account_id: snapshot.whatsappAccountId,
    p_phone_number_id: snapshot.phoneNumberId,
    p_display_name: snapshot.displayName,
  });
  if (rows === null || rows.length !== 1) return failedProvision();

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 1) return failedProvision();
    const { result } = row;
    return result === "provisioned" || result === "already_provisioned" ? { kind: result } : failedProvision();
  } catch {
    return failedProvision();
  }
}

/** Calls the `suspend_clinic_v1` Data API RPC over native fetch. Never logs the request/response body. */
export async function suspendClinic(clinicId: string, env: Env): Promise<SuspendClinicResult> {
  if (!UUID_PATTERN.test(clinicId)) return failedSuspend();
  const endpoint = buildEndpoint(env, "suspend_clinic_v1");
  if (!endpoint) return failedSuspend();

  const rows = await callRpc(endpoint, env, { p_clinic_id: clinicId });
  if (rows === null || rows.length !== 1) return failedSuspend();

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 1) return failedSuspend();
    const { result } = row;
    return result === "suspended" || result === "already_suspended" || result === "not_found" ? { kind: result } : failedSuspend();
  } catch {
    return failedSuspend();
  }
}

/** Calls the `resume_clinic_v1` Data API RPC over native fetch. Never logs the request/response body. */
export async function resumeClinic(clinicId: string, env: Env): Promise<ResumeClinicResult> {
  if (!UUID_PATTERN.test(clinicId)) return failedResume();
  const endpoint = buildEndpoint(env, "resume_clinic_v1");
  if (!endpoint) return failedResume();

  const rows = await callRpc(endpoint, env, { p_clinic_id: clinicId });
  if (rows === null || rows.length !== 1) return failedResume();

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 1) return failedResume();
    const { result } = row;
    return result === "resumed" || result === "already_active" || result === "refused_offboarding" || result === "not_found"
      ? { kind: result }
      : failedResume();
  } catch {
    return failedResume();
  }
}

/**
 * Calls the `prepare_clinic_offboarding_v1` Data API RPC over native fetch.
 * Never logs the request/response body, including the returned token: the
 * caller may retrieve the same token again through idempotent prepare replay,
 * and must never persist or print it before passing it to finalize.
 */
export async function prepareClinicOffboarding(clinicId: string, env: Env): Promise<PrepareClinicOffboardingResult> {
  if (!UUID_PATTERN.test(clinicId)) return failedPrepare();
  const endpoint = buildEndpoint(env, "prepare_clinic_offboarding_v1");
  if (!endpoint) return failedPrepare();

  const rows = await callRpc(endpoint, env, { p_clinic_id: clinicId });
  if (rows === null || rows.length !== 1) return failedPrepare();

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 2) return failedPrepare();
    const { result, offboarding_token: offboardingToken } = row;

    if (result === "not_found") {
      return offboardingToken === null ? { kind: "not_found" } : failedPrepare();
    }

    if (result !== "prepared" && result !== "already_offboarding") return failedPrepare();
    if (typeof offboardingToken !== "string" || !UUID_PATTERN.test(offboardingToken)) return failedPrepare();
    return { kind: result, offboardingToken };
  } catch {
    return failedPrepare();
  }
}

/** Calls the `finalize_clinic_offboarding_v1` Data API RPC over native fetch. Never logs the request/response body. */
export async function finalizeClinicOffboarding(clinicId: string, offboardingToken: string, env: Env): Promise<FinalizeClinicOffboardingResult> {
  if (!UUID_PATTERN.test(clinicId) || !UUID_PATTERN.test(offboardingToken)) return failedFinalize();
  const endpoint = buildEndpoint(env, "finalize_clinic_offboarding_v1");
  if (!endpoint) return failedFinalize();

  const rows = await callRpc(endpoint, env, { p_clinic_id: clinicId, p_offboarding_token: offboardingToken });
  if (rows === null || rows.length !== 1) return failedFinalize();

  const row = asPlainRecord(rows[0]);
  try {
    if (!row || Reflect.ownKeys(row).length !== 1) return failedFinalize();
    const { result } = row;
    return result === "finalized" || result === "already_offboarded" || result === "not_found" ? { kind: result } : failedFinalize();
  } catch {
    return failedFinalize();
  }
}
