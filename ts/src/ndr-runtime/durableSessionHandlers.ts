import type {
  SessionManager,
  OnDurableEventCallback,
} from "../SessionManager.js";
import type { Unsubscribe } from "../types.js";

type Registration = {
  kinds: readonly number[];
  callback: OnDurableEventCallback;
  cleanup?: Unsubscribe;
};

/** Runtime registrations survive reinitialization; a detached manager cannot ACK. */
export class RuntimeDurableSessionHandlers {
  private readonly registrations = new Set<Registration>();

  constructor(private readonly currentManager: () => SessionManager | null) {}

  onEvent(
    kinds: readonly number[],
    callback: OnDurableEventCallback,
  ): Unsubscribe {
    if (
      !kinds.length ||
      kinds.some((kind) => !Number.isSafeInteger(kind) || kind < 0)
    ) {
      throw new Error("Invalid durable event kinds");
    }
    const registration: Registration = { kinds: [...kinds], callback };
    this.registrations.add(registration);
    const manager = this.currentManager();
    if (manager) this.attachOne(manager, registration);
    return () => {
      registration.cleanup?.();
      this.registrations.delete(registration);
    };
  }

  attach(manager: SessionManager): void {
    for (const registration of this.registrations)
      this.attachOne(manager, registration);
  }

  clear(): void {
    for (const registration of this.registrations) {
      registration.cleanup?.();
      registration.cleanup = undefined;
    }
  }

  private attachOne(manager: SessionManager, registration: Registration): void {
    registration.cleanup?.();
    registration.cleanup = manager.onDurableEvent(
      registration.kinds,
      async (event, sender, meta) => {
        const active = () =>
          this.currentManager() === manager &&
          this.registrations.has(registration);
        if (!active()) throw new Error("Inactive durable event handler");
        await registration.callback(event, sender, meta);
        if (!active()) throw new Error("Inactive durable event handler");
      },
    );
  }
}
