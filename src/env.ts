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
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_GRAPH_API_VERSION: string;
}
