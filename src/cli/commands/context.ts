import type { AppConfig } from "../../storage/config-store.js";
import type { Storage } from "../../storage/index.js";

/** Load CLI configuration or fail with a clear, actionable message. */
export async function requireConfig(storage: Storage): Promise<AppConfig> {
  const config = await storage.config.load();
  if (!config) {
    throw new Error(
      "No CLI configuration found. Run dpdp login --token <token> --api <url> first.",
    );
  }
  return config;
}

/** Load the bearer token or fail with a clear, actionable message. */
export async function requireToken(storage: Storage): Promise<string> {
  const credentials = await storage.credentials.load();
  if (!credentials?.token) {
    throw new Error(
      "No CLI token found. Run dpdp login --token <token> --api <url> first.",
    );
  }
  return credentials.token;
}
