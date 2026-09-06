import type { IntakeQueueMessage } from "./intakeQueue";

export interface Env {
  APP_TIMEZONE: string;
  WHATSAPP_VERIFY_TOKEN: string;
  WHATSAPP_APP_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_ANON_KEY: string;
  OPENAI_API_KEY: string;
  INTAKE_QUEUE: Queue<IntakeQueueMessage>;
  WHATSAPP_ACCOUNT_CREDENTIALS_JSON: string;
  WHATSAPP_GRAPH_API_VERSION: string;
  // Task 053: operational alerting. Optional -- every consumer in
  // src/operationalAlerts.ts treats a missing/placeholder value as "not
  // configured" and fails closed (skips that check) rather than throwing.
  OPERATIONAL_ALERTS_ENABLED?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_ADDRESS?: string;
  STAFF_LOGIN_URL?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ALERTS_MONITORING_TOKEN?: string;
  DEPLOYMENT_NAME?: string;
  INTAKE_QUEUE_NAME?: string;
  INTAKE_DLQ_NAME?: string;
  INTAKE_TERMINAL_DLQ_NAME?: string;
}
