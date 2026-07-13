import type { VerifiedEvent } from "nostr-tools"

import type { StorageAdapter } from "./StorageAdapter"
import type { Rumor } from "./types"
import type {
  StoredSessionEntry,
  StoredUserRecord,
} from "./session-manager/types"
import type { UserRecordActor } from "./session-manager/UserRecordActor"
import { serializeSessionState } from "./utils"

export type OutboundIntentStage = "discovery" | "device"

export interface OutboundIntent {
  type: "intent"
  id: string
  stage: OutboundIntentStage
  targetKey: string
  event: Rumor
  createdAt: number
}

export interface PreparedPublish {
  type: "prepared"
  id: string
  event: VerifiedEvent
  innerEventId?: string
  createdAt: number
  attempts: number
  lastAttemptAt?: number
  lastError?: string
}

export interface PreparedPublishInput {
  event: VerifiedEvent
  innerEventId?: string
  intentId?: string
}

export interface PreparedTransition<T> {
  result: T
  userRecords: StoredUserRecord[]
  publishes: PreparedPublishInput[]
}

export interface PreparedTransitionContext {
  hasIntent(id: string): boolean
}

export type OutboundEntry = OutboundIntent | PreparedPublish

export interface RuntimeSnapshotV2 {
  version: 2
  userRecords: StoredUserRecord[]
  outbound: OutboundEntry[]
}

type LegacyQueueEntry = {
  id: string
  targetKey: string
  event: Rumor
  createdAt: number
}

const SNAPSHOT_KEY = "v2/runtime-snapshot"
const LEGACY_USER_PREFIX = "v1/user/"
const LEGACY_DISCOVERY_PREFIX = "v1/discovery-queue/"
const LEGACY_DEVICE_PREFIX = "v1/message-queue/"

const emptySnapshot = (): RuntimeSnapshotV2 => ({
  version: 2,
  userRecords: [],
  outbound: [],
})

const serializeUserRecord = (
  publicKey: string,
  userRecord: UserRecordActor,
): StoredUserRecord => {
  const serializeSession = (session: {
    name: string
    state: Parameters<typeof serializeSessionState>[0]
  }): StoredSessionEntry => ({
    name: session.name,
    state: serializeSessionState(session.state),
  })

  return {
    publicKey,
    devices: Array.from(userRecord.devices.values()).map((device) => ({
      deviceId: device.deviceId,
      activeSession: device.activeSession
        ? serializeSession(device.activeSession)
        : null,
      inactiveSessions: device.inactiveSessions.map(serializeSession),
      createdAt: device.createdAt,
    })),
    appKeys: userRecord.appKeys?.serialize(),
    appKeysCreatedAt: userRecord.appKeysCreatedAt(),
  }
}

export const serializeUserRecords = (
  userRecords: Map<string, UserRecordActor>,
): StoredUserRecord[] =>
  Array.from(userRecords, ([publicKey, record]) =>
    serializeUserRecord(publicKey, record)
  )

/**
 * Durable state for the TypeScript runtime. Every transition is a single-key
 * replacement so ratchet records and already-prepared relay events cannot
 * diverge across a crash.
 */
export class RuntimeState {
  private snapshot = emptySnapshot()
  private transitionTail: Promise<void> = Promise.resolve()

  constructor(private readonly storage: StorageAdapter) {}

  async init(): Promise<void> {
    await this.serialize(async () => {
      const stored = await this.storage.get<unknown>(SNAPSHOT_KEY)
      if (stored !== undefined) {
        if (this.isSnapshot(stored)) {
          this.snapshot = stored
          return
        }
        throw new Error("Unsupported or corrupt NDR runtime snapshot")
      }

      const migrated = await this.migrateLegacyState()
      await this.storage.put(SNAPSHOT_KEY, migrated)
      this.snapshot = migrated
      await this.deleteLegacyState()
    })
  }

  userRecords(): StoredUserRecord[] {
    return this.snapshot.userRecords
  }

  intents(stage?: OutboundIntentStage): OutboundIntent[] {
    return this.snapshot.outbound.filter(
      (entry): entry is OutboundIntent =>
        entry.type === "intent" && (!stage || entry.stage === stage)
    )
  }

  preparedPublishes(): PreparedPublish[] {
    return this.snapshot.outbound.filter(
      (entry): entry is PreparedPublish => entry.type === "prepared"
    )
  }

  async persistRecords(userRecords: StoredUserRecord[]): Promise<void> {
    await this.replaceRecords(userRecords)
  }

  async addIntent(
    stage: OutboundIntentStage,
    targetKey: string,
    event: Rumor,
  ): Promise<string> {
    const id = `${event.id}/${targetKey}`
    await this.updateOutbound((outbound) => {
      const withoutDuplicate = outbound.filter(
        (entry) =>
          !(
            entry.type === "intent" &&
            entry.stage === stage &&
            entry.id === id
          )
      )
      return [
        ...withoutDuplicate,
        { type: "intent", id, stage, targetKey, event, createdAt: Date.now() },
      ]
    })
    return id
  }

  async removeIntent(
    stage: OutboundIntentStage,
    id: string,
  ): Promise<void> {
    await this.updateOutbound((outbound) =>
      outbound.filter(
        (entry) =>
          !(entry.type === "intent" && entry.stage === stage && entry.id === id)
      )
    )
  }

  async removeIntentsForTarget(
    stage: OutboundIntentStage,
    targetKey: string,
  ): Promise<void> {
    await this.updateOutbound((outbound) =>
      outbound.filter(
        (entry) =>
          !(
            entry.type === "intent" &&
            entry.stage === stage &&
            entry.targetKey === targetKey
          )
      )
    )
  }

  async commitPreparedTransition<T>(
    mutate: (context: PreparedTransitionContext) => PreparedTransition<T>,
    checkpoint: () => () => void,
  ): Promise<T> {
    return this.serialize(async () => {
      const rollback = checkpoint()
      let transition: PreparedTransition<T>
      try {
        transition = mutate({
          hasIntent: (id) => this.snapshot.outbound.some(
            (entry) => entry.type === "intent" && entry.id === id
          ),
        })
      } catch (error) {
        rollback()
        throw error
      }

      const next: RuntimeSnapshotV2 = {
        version: 2,
        userRecords: transition.userRecords,
        outbound: prepareOutbound(this.snapshot.outbound, transition.publishes),
      }
      try {
        await this.storage.put(SNAPSHOT_KEY, next)
      } catch (error) {
        rollback()
        throw error
      }
      this.snapshot = next
      return transition.result
    })
  }

  async acknowledgePublish(id: string): Promise<void> {
    await this.updateOutbound((outbound) =>
      outbound.filter(
        (entry) => !(entry.type === "prepared" && entry.id === id)
      )
    )
  }

  async publishFailed(
    id: string,
    error: string,
  ): Promise<void> {
    await this.updateOutbound((outbound) =>
      outbound.map((entry) =>
        entry.type === "prepared" && entry.id === id
          ? {
              ...entry,
              attempts: entry.attempts + 1,
              lastAttemptAt: Date.now(),
              lastError: error,
            }
          : entry
      )
    )
  }

  async deleteUser(
    userRecords: StoredUserRecord[],
    publicKey: string,
  ): Promise<void> {
    await this.replaceRecords(
      userRecords.filter((record) => record.publicKey !== publicKey),
    )
  }

  private async replaceRecords(userRecords: StoredUserRecord[]): Promise<void> {
    await this.serialize(async () => {
      const next: RuntimeSnapshotV2 = {
        version: 2,
        userRecords,
        outbound: this.snapshot.outbound,
      }
      await this.storage.put(SNAPSHOT_KEY, next)
      this.snapshot = next
    })
  }

  private async updateOutbound(
    reduce: (current: OutboundEntry[]) => OutboundEntry[],
  ): Promise<void> {
    await this.serialize(async () => {
      const next: RuntimeSnapshotV2 = {
        version: 2,
        userRecords: this.snapshot.userRecords,
        outbound: reduce(this.snapshot.outbound),
      }
      await this.storage.put(SNAPSHOT_KEY, next)
      this.snapshot = next
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transitionTail.then(operation, operation)
    this.transitionTail = next.then(() => {}, () => {})
    return next
  }

  private isSnapshot(value: unknown): value is RuntimeSnapshotV2 {
    if (!value || typeof value !== "object") return false
    const snapshot = value as Partial<RuntimeSnapshotV2>
    if (
      snapshot.version === 2 &&
      Array.isArray(snapshot.userRecords) &&
      Array.isArray(snapshot.outbound)
    ) {
      return snapshot.userRecords.every(
        (record) =>
          Boolean(record) &&
          typeof record === "object" &&
          typeof record.publicKey === "string" &&
          Array.isArray(record.devices) &&
          (record.appKeysCreatedAt === undefined ||
            typeof record.appKeysCreatedAt === "number")
      ) && snapshot.outbound.every((entry) => {
        if (
          !entry ||
          typeof entry !== "object" ||
          typeof entry.id !== "string" ||
          typeof entry.createdAt !== "number"
        ) return false
        if (entry.type === "intent") {
          return (
            (entry.stage === "discovery" || entry.stage === "device") &&
            typeof entry.targetKey === "string" &&
            this.isStoredEvent(entry.event, false)
          )
        }
        return (
          entry.type === "prepared" &&
          typeof entry.attempts === "number" &&
          this.isStoredEvent(entry.event, true) &&
          entry.event.id === entry.id
        )
      })
    }
    return false
  }

  private isStoredEvent(value: unknown, signed: boolean): boolean {
    if (!value || typeof value !== "object") return false
    const event = value as Partial<VerifiedEvent>
    return (
      typeof event.id === "string" &&
      typeof event.pubkey === "string" &&
      typeof event.created_at === "number" &&
      typeof event.kind === "number" &&
      Array.isArray(event.tags) &&
      typeof event.content === "string" &&
      (!signed || typeof event.sig === "string")
    )
  }

  private async migrateLegacyState(): Promise<RuntimeSnapshotV2> {
    const userRecordKeys = await this.storage.list(LEGACY_USER_PREFIX)
    const userRecords = (
      await Promise.all(
        userRecordKeys.map((key) => this.storage.get<StoredUserRecord>(key))
      )
    ).filter((record): record is StoredUserRecord => Boolean(record))

    const outbound = await Promise.all([
      this.loadLegacyIntents(LEGACY_DISCOVERY_PREFIX, "discovery"),
      this.loadLegacyIntents(LEGACY_DEVICE_PREFIX, "device"),
    ])

    return {
      version: 2,
      userRecords,
      outbound: outbound.flat(),
    }
  }

  private async loadLegacyIntents(
    prefix: string,
    stage: OutboundIntentStage,
  ): Promise<OutboundIntent[]> {
    const keys = await this.storage.list(prefix)
    const entries = await Promise.all(
      keys.map((key) => this.storage.get<LegacyQueueEntry>(key))
    )
    return entries.flatMap((entry) => entry ? [{ ...entry, type: "intent", stage }] : [])
  }

  private async deleteLegacyState(): Promise<void> {
    const prefixes = [
      LEGACY_USER_PREFIX,
      LEGACY_DISCOVERY_PREFIX,
      LEGACY_DEVICE_PREFIX,
    ]
    const keys = (await Promise.all(prefixes.map((prefix) => this.storage.list(prefix)))).flat()
    await Promise.allSettled(keys.map((key) => this.storage.del(key)))
  }
}

export class OutboundIntentQueue {
  constructor(
    private readonly runtimeState: RuntimeState,
    private readonly stage: OutboundIntentStage,
  ) {}

  add(targetKey: string, event: Rumor): Promise<string> {
    return this.runtimeState.addIntent(this.stage, targetKey, event)
  }

  getForTarget(targetKey: string): Promise<OutboundIntent[]> {
    return Promise.resolve(
      this.runtimeState.intents(this.stage)
        .filter((entry) => entry.targetKey === targetKey)
        .sort((a, b) => a.createdAt - b.createdAt)
    )
  }

  entries(): Promise<OutboundIntent[]> {
    return Promise.resolve(
      this.runtimeState.intents(this.stage)
        .sort((a, b) => a.createdAt - b.createdAt)
    )
  }

  removeForTarget(targetKey: string): Promise<void> {
    return this.runtimeState.removeIntentsForTarget(
      this.stage,
      targetKey,
    )
  }

  remove(id: string): Promise<void> {
    return this.runtimeState.removeIntent(this.stage, id)
  }
}

function prepareOutbound(
  current: OutboundEntry[],
  publishes: PreparedPublishInput[],
): OutboundEntry[] {
  const intentIds = new Set(
    publishes.flatMap(({ intentId }) => intentId ? [intentId] : [])
  )
  const existingPreparedIds = new Set(
    current.flatMap((entry) => entry.type === "prepared" ? [entry.id] : [])
  )
  const next = current.filter(
    (entry) => !(entry.type === "intent" && intentIds.has(entry.id))
  )
  for (const publish of publishes) {
    if (existingPreparedIds.has(publish.event.id)) continue
    next.push({
      type: "prepared",
      id: publish.event.id,
      event: publish.event,
      innerEventId: publish.innerEventId,
      createdAt: Date.now(),
      attempts: 0,
    })
    existingPreparedIds.add(publish.event.id)
  }
  return next
}
