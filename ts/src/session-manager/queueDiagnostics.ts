import type { MessageQueue } from "../MessageQueue.js"
import type { UserRecordActor } from "./UserRecordActor.js"

export type QueuedMessageStage = "discovery" | "device"

export interface QueuedMessageDiagnostic {
  stage: QueuedMessageStage
  targetKey: string
  ownerPubkey?: string
  innerEventId?: string
  createdAt: number
}

export async function queuedMessageDiagnostics(input: {
  userRecords: Map<string, UserRecordActor>
  discoveryQueue: MessageQueue
  messageQueue: MessageQueue
  innerEventId?: string
}): Promise<QueuedMessageDiagnostic[]> {
  const deviceToOwner = new Map<string, string>()
  for (const [ownerPubkey, record] of input.userRecords) {
    for (const deviceId of record.devices.keys()) {
      deviceToOwner.set(deviceId, ownerPubkey)
    }
    for (const device of record.appKeys?.getAllDevices() ?? []) {
      if (device.identityPubkey) {
        deviceToOwner.set(device.identityPubkey, ownerPubkey)
      }
    }
  }

  const diagnostics: QueuedMessageDiagnostic[] = []
  for (const entry of await input.discoveryQueue.entries()) {
    const entryInnerEventId = entry.event.id
    if (input.innerEventId && entryInnerEventId !== input.innerEventId) continue
    diagnostics.push({
      stage: "discovery",
      targetKey: entry.targetKey,
      ownerPubkey: entry.targetKey,
      innerEventId: entryInnerEventId,
      createdAt: entry.createdAt,
    })
  }

  for (const entry of await input.messageQueue.entries()) {
    const entryInnerEventId = entry.event.id
    if (input.innerEventId && entryInnerEventId !== input.innerEventId) continue
    diagnostics.push({
      stage: "device",
      targetKey: entry.targetKey,
      ownerPubkey: deviceToOwner.get(entry.targetKey),
      innerEventId: entryInnerEventId,
      createdAt: entry.createdAt,
    })
  }

  return diagnostics.sort((a, b) => a.createdAt - b.createdAt)
}
