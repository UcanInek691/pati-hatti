export const APP_VERSION = "0.1.0";

export function getHealth(): { status: "ok"; version: string; timestamp: string } {
  return {
    status: "ok",
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  };
}
