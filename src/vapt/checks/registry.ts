import type { VaptTargetType } from "../scope/types.js";
import type { VaptCheck } from "./types.js";

/**
 * Internal check registry.
 *
 * Checks are registered at composition time (see `src/vapt/profile`); the
 * VAPT engine only executes whatever is registered. Adding a future check
 * means registering it — the engine itself does not change. No dynamic
 * plugin loading.
 */
export class CheckRegistry {
  private readonly checks = new Map<string, VaptCheck>();

  register(check: VaptCheck): void {
    if (this.checks.has(check.checkId)) {
      throw new Error(`Check already registered: ${check.checkId}`);
    }
    this.checks.set(check.checkId, check);
  }

  unregister(checkId: string): boolean {
    return this.checks.delete(checkId);
  }

  get(checkId: string): VaptCheck | undefined {
    return this.checks.get(checkId);
  }

  list(): VaptCheck[] {
    return [...this.checks.values()];
  }

  /** Checks that support the given target type. */
  forTargetType(targetType: VaptTargetType): VaptCheck[] {
    return this.list().filter((check) => check.supportedTargetTypes.includes(targetType));
  }
}
