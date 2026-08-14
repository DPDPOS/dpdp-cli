import type { Analyzer } from "../../analyzers/analyzer.js";
import type { SourceKind } from "../../evidence/types.js";

/**
 * Internal analyzer registry.
 *
 * Analyzers are registered at composition time (see `core/profiles`); the
 * scanner engine only executes whatever is registered. Adding a future
 * analyzer means registering it — the engine itself does not change.
 */
export class AnalyzerRegistry {
  private readonly analyzers = new Map<string, Analyzer>();

  register(analyzer: Analyzer): void {
    if (this.analyzers.has(analyzer.id)) {
      throw new Error(`Analyzer already registered: ${analyzer.id}`);
    }
    this.analyzers.set(analyzer.id, analyzer);
  }

  unregister(id: string): boolean {
    return this.analyzers.delete(id);
  }

  get(id: string): Analyzer | undefined {
    return this.analyzers.get(id);
  }

  list(): Analyzer[] {
    return [...this.analyzers.values()];
  }

  /** Analyzers that accept the given source kind. */
  forKind(kind: SourceKind): Analyzer[] {
    return this.list().filter((analyzer) => analyzer.supportedKinds.includes(kind));
  }
}
