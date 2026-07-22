import { Filter, VerifiedEvent } from "nostr-tools"
import { matchFilter } from "nostr-tools"

/**
 * Check if a Nostr event kind is replaceable (only the latest event per key should be kept).
 * - Kind 0, 3: regular replaceable
 * - Kind 10000-19999: regular replaceable
 * - Kind 30000-39999: parameterized replaceable (keyed by d-tag)
 */
function isReplaceableKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000) || (kind >= 30000 && kind < 40000)
}

/**
 * Get the replaceable event key for deduplication.
 * For parameterized replaceable events (30000-39999), includes the d-tag.
 */
function getReplaceableKey(event: VerifiedEvent): string {
  if (event.kind >= 30000 && event.kind < 40000) {
    const dTag = event.tags?.find((t: string[]) => t[0] === "d")?.[1] || ""
    return `${event.kind}:${event.pubkey}:${dTag}`
  }
  return `${event.kind}:${event.pubkey}`
}

/**
 * Filter a list of events so that only the latest replaceable event per key is included.
 * Non-replaceable events are always included.
 */
function deduplicateReplaceable(events: VerifiedEvent[]): VerifiedEvent[] {
  const latestByKey = new Map<string, VerifiedEvent>()
  const nonReplaceable: VerifiedEvent[] = []

  for (const event of events) {
    if (isReplaceableKind(event.kind)) {
      const key = getReplaceableKey(event)
      const existing = latestByKey.get(key)
      if (!existing || event.created_at >= existing.created_at) {
        latestByKey.set(key, event)
      }
    } else {
      nonReplaceable.push(event)
    }
  }

  return [...nonReplaceable, ...latestByKey.values()]
}

interface Subscription {
  id: string
  filter: Filter
  onEvent: (event: VerifiedEvent) => void
  group?: string
}

interface DeliveryRecord {
  subscriberId: string
  eventId: string
  timestamp: number
}

interface HeldEvent {
  event: VerifiedEvent
  delivered: boolean
}

let subIdCounter = 0

export class ControlledMockRelay {
  private events: VerifiedEvent[] = []
  private subscriptions: Map<string, Subscription> = new Map()
  private deliveryHistory: DeliveryRecord[] = []
  private deliveryCount: Map<string, number> = new Map()

  private currentRef: string | null = null
  private heldEvents: Map<string, HeldEvent[]> = new Map()
  private droppedRefs: Set<string> = new Set()

  subscribe(
    filter: Filter,
    onEvent: (event: VerifiedEvent) => void,
    options?: { group?: string },
  ): { id: string; close: () => void } {
    const id = `sub-${++subIdCounter}`
    const sub: Subscription = { id, filter, onEvent, group: options?.group }
    this.subscriptions.set(id, sub)

    // Deliver existing matching events via microtask to avoid TDZ issues
    // (e.g., waitForActivation accesses `unsubscribe` inside the callback,
    // which isn't assigned until subscribe() returns)
    // For replaceable events, only deliver the latest per author+d-tag (Nostr relay behavior).
    const existingMatches = deduplicateReplaceable(
      this.events.filter((event) => matchFilter(filter, event))
    )
    if (existingMatches.length > 0) {
      queueMicrotask(() => {
        for (const event of existingMatches) {
          if (this.subscriptions.has(id)) {
            this.recordDelivery(id, event.id)
            onEvent(event)
          }
        }
      })
    }

    return {
      id,
      close: () => {
        this.subscriptions.delete(id)
      },
    }
  }

  /**
   * Always stores + delivers immediately to all matching subs.
   */
  async publishAndDeliver(event: VerifiedEvent): Promise<void> {
    this.events.push(event)
    for (const sub of this.subscriptions.values()) {
      if (matchFilter(sub.filter, event)) {
        this.recordDelivery(sub.id, event.id)
        sub.onEvent(event)
      }
    }
  }

  /**
   * Stores event. If currentRef is set, holds events under that ref.
   * Otherwise delivers immediately.
   */
  storeAndDeliver(event: VerifiedEvent): void {
    this.events.push(event)

    if (this.currentRef) {
      const ref = this.currentRef
      if (!this.heldEvents.has(ref)) {
        this.heldEvents.set(ref, [])
      }
      this.heldEvents.get(ref)!.push({ event, delivered: false })
      return
    }

    // Deliver immediately
    for (const sub of this.subscriptions.values()) {
      if (matchFilter(sub.filter, event)) {
        this.recordDelivery(sub.id, event.id)
        sub.onEvent(event)
      }
    }
  }

  setCurrentRef(ref: string | null): void {
    this.currentRef = ref
  }

  /**
   * Deliver all held events under the given ref to all matching subs.
   */
  deliverEvent(ref: string): void {
    if (this.droppedRefs.has(ref)) return
    const held = this.heldEvents.get(ref)
    if (!held) return

    for (const entry of held) {
      if (entry.delivered) continue
      entry.delivered = true
      for (const sub of this.subscriptions.values()) {
        if (matchFilter(sub.filter, entry.event)) {
          this.recordDelivery(sub.id, entry.event.id)
          sub.onEvent(entry.event)
        }
      }
    }
  }

  /**
   * Deliver held events under ref only to subs matching the given group.
   */
  deliverToGroup(ref: string, group: string): void {
    if (this.droppedRefs.has(ref)) return
    const held = this.heldEvents.get(ref)
    if (!held) return

    for (const entry of held) {
      for (const sub of this.subscriptions.values()) {
        if (sub.group === group && matchFilter(sub.filter, entry.event)) {
          this.recordDelivery(sub.id, entry.event.id)
          sub.onEvent(entry.event)
        }
      }
    }
  }

  /**
   * Deliver all held events across all refs.
   */
  deliverAll(): void {
    for (const [ref] of this.heldEvents) {
      if (!this.droppedRefs.has(ref)) {
        this.deliverEvent(ref)
      }
    }
  }

  /**
   * Drop held events for the given ref (never deliver).
   */
  dropEvent(ref: string): void {
    this.droppedRefs.add(ref)
    this.heldEvents.delete(ref)
  }

  /**
   * Re-deliver an already-stored event to all matching subs.
   */
  duplicateEvent(eventId: string): void {
    const event = this.events.find((e) => e.id === eventId)
    if (!event) return

    for (const sub of this.subscriptions.values()) {
      if (matchFilter(sub.filter, event)) {
        this.recordDelivery(sub.id, event.id)
        sub.onEvent(event)
      }
    }
  }

  getDeliveryHistory(): DeliveryRecord[] {
    return [...this.deliveryHistory]
  }

  getSubscriptions(): Array<{ id: string; filter: Filter; group?: string }> {
    return Array.from(this.subscriptions.values()).map((s) => ({
      id: s.id,
      filter: s.filter,
      group: s.group,
    }))
  }

  getAllEvents(): VerifiedEvent[] {
    return [...this.events]
  }

  getDeliveryCount(eventId: string): number {
    return this.deliveryCount.get(eventId) || 0
  }

  private recordDelivery(subscriberId: string, eventId: string): void {
    this.deliveryHistory.push({
      subscriberId,
      eventId,
      timestamp: Date.now(),
    })
    this.deliveryCount.set(eventId, (this.deliveryCount.get(eventId) || 0) + 1)
  }
}
