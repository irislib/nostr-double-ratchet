import {
  finalizeEvent,
  type Filter,
  generateSecretKey,
  getPublicKey,
  matchFilter,
  type UnsignedEvent,
  type VerifiedEvent,
} from "nostr-tools";

import { NdrRuntime } from "../src/NdrRuntime.js";

import { InMemoryStorageAdapter } from "../src/StorageAdapter.js";

import {
  type NostrPublish,
  type NostrSubscribe,
  type Rumor,
} from "../src/types.js";

export const BENCH_NAME = "ndr-relay-churn";

export type ClientName = "alice" | "bob" | "carol";

export type Scenario = "direct" | "group";

export interface BenchPayload {
  bench: typeof BENCH_NAME;
  runId: string;
  scenario: Scenario;
  phase: "warmup" | "measure";
  id: string;
  from: ClientName;
  to?: ClientName;
  sentAt: number;
  index: number;
}

export interface ClientRelayStats {
  subscribeCalls: number;
  unsubscribeCalls: number;
  publishCalls: number;
  replayedEvents: number;
  liveEventsDelivered: number;
  deliveredEvents: number;
  subscriptionBytes: number;
  publishBytes: number;
  deliveredBytes: number;
}

export interface RelayStats {
  subscribeCalls: number;
  unsubscribeCalls: number;
  publishCalls: number;
  replayedEvents: number;
  liveEventsDelivered: number;
  deliveredEvents: number;
  subscriptionBytes: number;
  publishBytes: number;
  deliveredBytes: number;
  storedEvents: number;
  activeSubscriptions: number;
  maxActiveSubscriptions: number;
  byClient: Record<ClientName, ClientRelayStats>;
}

export interface Subscription {
  id: string;
  client: ClientName;
  filter: Filter;
  onEvent: (event: VerifiedEvent) => void;
}

export interface Participant {
  name: ClientName;
  ownerPubkey: string;
  runtime: NdrRuntime;
}

export interface LatencySummary {
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  avgMs: number;
}

export interface ScenarioMetrics {
  sent: number;
  expectedDeliveries: number;
  receivedDeliveries: number;
  timedOutDeliveries: number;
  duplicateDecodedDeliveries: number;
  unexpectedDeliveries: number;
  latency: LatencySummary;
}

export function makeClientStats(): ClientRelayStats {
  return {
    subscribeCalls: 0,
    unsubscribeCalls: 0,
    publishCalls: 0,
    replayedEvents: 0,
    liveEventsDelivered: 0,
    deliveredEvents: 0,
    subscriptionBytes: 0,
    publishBytes: 0,
    deliveredBytes: 0,
  };
}

export function makeRelayStats(): RelayStats {
  return {
    subscribeCalls: 0,
    unsubscribeCalls: 0,
    publishCalls: 0,
    replayedEvents: 0,
    liveEventsDelivered: 0,
    deliveredEvents: 0,
    subscriptionBytes: 0,
    publishBytes: 0,
    deliveredBytes: 0,
    storedEvents: 0,
    activeSubscriptions: 0,
    maxActiveSubscriptions: 0,
    byClient: {
      alice: makeClientStats(),
      bob: makeClientStats(),
      carol: makeClientStats(),
    },
  };
}

export function isReplaceableKind(kind: number): boolean {
  return (
    kind === 0 ||
    kind === 3 ||
    (kind >= 10_000 && kind < 20_000) ||
    (kind >= 30_000 && kind < 40_000)
  );
}

export function replaceableKey(event: VerifiedEvent): string {
  if (event.kind >= 30_000 && event.kind < 40_000) {
    const dTag = event.tags.find((tag) => tag[0] === "d")?.[1] || "";
    return `${event.kind}:${event.pubkey}:${dTag}`;
  }
  return `${event.kind}:${event.pubkey}`;
}

export function dedupeReplaceable(events: VerifiedEvent[]): VerifiedEvent[] {
  const latestReplaceable = new Map<string, VerifiedEvent>();
  const nonReplaceable: VerifiedEvent[] = [];

  for (const event of events) {
    if (!isReplaceableKind(event.kind)) {
      nonReplaceable.push(event);
      continue;
    }

    const key = replaceableKey(event);
    const existing = latestReplaceable.get(key);
    if (!existing || event.created_at >= existing.created_at) {
      latestReplaceable.set(key, event);
    }
  }

  return [...nonReplaceable, ...latestReplaceable.values()];
}

export function wireBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

export class InstrumentedRelay {
  private events: VerifiedEvent[] = [];
  private subscriptions = new Map<string, Subscription>();
  private stats = makeRelayStats();
  private nextSubId = 0;

  subscribe(
    client: ClientName,
    filter: Filter,
    onEvent: (event: VerifiedEvent) => void,
  ): { id: string; close: () => void } {
    const id = `${client}-sub-${++this.nextSubId}`;
    const subscription: Subscription = { id, client, filter, onEvent };
    this.subscriptions.set(id, subscription);

    const subscriptionBytes = wireBytes(["REQ", id, filter]);
    this.stats.subscribeCalls += 1;
    this.stats.subscriptionBytes += subscriptionBytes;
    this.stats.activeSubscriptions = this.subscriptions.size;
    this.stats.maxActiveSubscriptions = Math.max(
      this.stats.maxActiveSubscriptions,
      this.stats.activeSubscriptions,
    );
    const clientStats = this.stats.byClient[client];
    clientStats.subscribeCalls += 1;
    clientStats.subscriptionBytes += subscriptionBytes;

    const matches = dedupeReplaceable(
      this.events.filter((event) => matchFilter(filter, event)),
    );
    for (const event of matches) {
      this.deliver(subscription, event, "replay");
    }

    let closed = false;
    return {
      id,
      close: () => {
        if (closed) return;
        closed = true;
        if (!this.subscriptions.delete(id)) return;
        this.stats.unsubscribeCalls += 1;
        this.stats.activeSubscriptions = this.subscriptions.size;
        this.stats.byClient[client].unsubscribeCalls += 1;
      },
    };
  }

  storeAndDeliver(client: ClientName, event: VerifiedEvent): void {
    this.events.push(event);
    this.stats.storedEvents = this.events.length;
    this.stats.publishCalls += 1;
    this.stats.publishBytes += wireBytes(["EVENT", event]);
    const clientStats = this.stats.byClient[client];
    clientStats.publishCalls += 1;
    clientStats.publishBytes += wireBytes(["EVENT", event]);

    for (const subscription of Array.from(this.subscriptions.values())) {
      if (matchFilter(subscription.filter, event)) {
        this.deliver(subscription, event, "live");
      }
    }
  }

  resetCounters(): void {
    const activeSubscriptions = this.subscriptions.size;
    this.stats = makeRelayStats();
    this.stats.storedEvents = this.events.length;
    this.stats.activeSubscriptions = activeSubscriptions;
    this.stats.maxActiveSubscriptions = activeSubscriptions;
  }

  snapshot(): RelayStats {
    return JSON.parse(JSON.stringify(this.stats)) as RelayStats;
  }

  private deliver(
    subscription: Subscription,
    event: VerifiedEvent,
    source: "live" | "replay",
  ): void {
    const bytes = wireBytes(["EVENT", subscription.id, event]);
    this.stats.deliveredEvents += 1;
    this.stats.deliveredBytes += bytes;
    const clientStats = this.stats.byClient[subscription.client];
    clientStats.deliveredEvents += 1;
    clientStats.deliveredBytes += bytes;

    if (source === "replay") {
      this.stats.replayedEvents += 1;
      clientStats.replayedEvents += 1;
    } else {
      this.stats.liveEventsDelivered += 1;
      clientStats.liveEventsDelivered += 1;
    }

    subscription.onEvent(event);
  }
}

export class DeliveryMetrics {
  sent = 0;
  expectedDeliveries = 0;
  receivedDeliveries = 0;
  timedOutDeliveries = 0;
  duplicateDecodedDeliveries = 0;
  unexpectedDeliveries = 0;
  readonly latencies: number[] = [];
  private readonly seen = new Set<string>();

  recordSend(expectedDeliveries: number): void {
    this.sent += 1;
    this.expectedDeliveries += expectedDeliveries;
  }

  recordDelivery(deliveryKey: string, latencyMs: number): void {
    if (this.seen.has(deliveryKey)) {
      this.duplicateDecodedDeliveries += 1;
      return;
    }
    this.seen.add(deliveryKey);
    this.receivedDeliveries += 1;
    this.latencies.push(latencyMs);
  }

  recordTimeout(missingDeliveries: number): void {
    this.timedOutDeliveries += missingDeliveries;
  }

  recordUnexpected(): void {
    this.unexpectedDeliveries += 1;
  }

  summary(): ScenarioMetrics {
    return {
      sent: this.sent,
      expectedDeliveries: this.expectedDeliveries,
      receivedDeliveries: this.receivedDeliveries,
      timedOutDeliveries: this.timedOutDeliveries,
      duplicateDecodedDeliveries: this.duplicateDecodedDeliveries,
      unexpectedDeliveries: this.unexpectedDeliveries,
      latency: summarizeLatency(this.latencies),
    };
  }
}

export function summarizeLatency(values: number[]): LatencySummary {
  if (values.length === 0) {
    return {
      count: 0,
      minMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      avgMs: 0,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => {
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(sorted.length * fraction) - 1),
    );
    return sorted[index]!;
  };
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    minMs: sorted[0]!,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted[sorted.length - 1]!,
    avgMs: Math.round((total / sorted.length) * 10) / 10,
  };
}

export function parsePayload(content: string): BenchPayload | null {
  try {
    const value = JSON.parse(content) as Partial<BenchPayload>;
    if (value.bench !== BENCH_NAME) return null;
    if (typeof value.runId !== "string") return null;
    if (value.scenario !== "direct" && value.scenario !== "group") return null;
    if (value.phase !== "warmup" && value.phase !== "measure") return null;
    if (typeof value.id !== "string") return null;
    if (!isClientName(value.from)) return null;
    if (value.to !== undefined && !isClientName(value.to)) return null;
    if (typeof value.sentAt !== "number") return null;
    if (typeof value.index !== "number") return null;
    return value as BenchPayload;
  } catch {
    return null;
  }
}

export function isClientName(value: unknown): value is ClientName {
  return value === "alice" || value === "bob" || value === "carol";
}

export function createParticipant(name: ClientName, relay: InstrumentedRelay): Participant {
  const ownerPrivateKey = generateSecretKey();
  const ownerPubkey = getPublicKey(ownerPrivateKey);

  const nostrSubscribe: NostrSubscribe = (filter, onEvent) =>
    relay.subscribe(name, filter, onEvent).close;

  const nostrPublish: NostrPublish = async (
    event: UnsignedEvent | VerifiedEvent,
  ) => {
    const signed =
      "sig" in event && event.sig
        ? (event as VerifiedEvent)
        : (finalizeEvent(event as UnsignedEvent, ownerPrivateKey) as VerifiedEvent);
    relay.storeAndDeliver(name, signed);
    return signed;
  };

  return {
    name,
    ownerPubkey,
    runtime: new NdrRuntime({
      nostrSubscribe,
      nostrPublish,
      storage: new InMemoryStorageAdapter(),
      appKeysFastTimeoutMs: 50,
      appKeysFetchTimeoutMs: 500,
    }),
  };
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function initializeParticipants(participants: Participant[]): Promise<void> {
  for (const participant of participants) {
    await participant.runtime.initForOwner(participant.ownerPubkey);
    await participant.runtime.registerCurrentDevice({
      ownerPubkey: participant.ownerPubkey,
      timeoutMs: 1_000,
    });
    await participant.runtime.republishInvite();
  }

  for (const participant of participants) {
    for (const peer of participants) {
      if (participant === peer) continue;
      await participant.runtime.setupUser(peer.ownerPubkey);
    }
  }
}

export function buildPayload(input: {
  runId: string;
  scenario: Scenario;
  phase: "warmup" | "measure";
  from: ClientName;
  to?: ClientName;
  index: number;
}): BenchPayload {
  return {
    bench: BENCH_NAME,
    id: `${input.scenario}-${input.phase}-${input.from}-${input.to || "all"}-${input.index}`,
    sentAt: Date.now(),
    ...input,
  };
}
