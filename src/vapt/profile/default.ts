import {
  certificateValidityCheck,
  httpsAvailabilityCheck,
  protocolVersionCheck,
} from "../checks/tls.js";
import { securityHeadersCheck } from "../checks/http-headers.js";
import { CheckRegistry } from "../checks/registry.js";
import type { VaptScanConfig } from "./types.js";

export const VAPT_SCANNER_NAME = "dpdp-cli";
export const VAPT_CLI_VERSION = "0.1.0";
export const VAPT_ENGINE_VERSION = "0.1.0";
export const VAPT_CHECK_CATALOG_VERSION = "1.0.0";

/**
 * Default VAPT profile: the production wiring of the capability. This is the
 * composition root — adding a future check means registering it here (plus
 * tests), with no changes to the engine or the CLI entry point.
 */
export function createDefaultVaptProfile(): {
  registry: CheckRegistry;
  config: VaptScanConfig;
} {
  const registry = new CheckRegistry();
  registry.register(httpsAvailabilityCheck);
  registry.register(certificateValidityCheck);
  registry.register(protocolVersionCheck);
  registry.register(securityHeadersCheck);
  return {
    registry,
    config: {
      profile: "web-baseline",
      checkCategories: ["tls", "http-headers"],
      mode: "passive",
      timeoutMs: 10_000,
      concurrency: 1,
      ratePerSecond: 5,
      safeMode: true,
      toolConfig: {
        engineVersion: VAPT_ENGINE_VERSION,
        checkCatalogVersion: VAPT_CHECK_CATALOG_VERSION,
      },
    },
  };
}
