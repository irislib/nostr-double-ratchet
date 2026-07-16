import { StorageAdapter } from "./StorageAdapter.js"
import { Rumor } from "./types.js"

export interface QueueEntry {
  id: string
  targetKey: string
  event: Rumor
  createdAt: number
}

export class MessageQueue {
  private storage: StorageAdapter
  private prefix: string

  constructor(storage: StorageAdapter, prefix: string) {
    this.storage = storage
    this.prefix = prefix
  }

  async add(targetKey: string, event: Rumor): Promise<string> {
    const id = event.id + "/" + targetKey
    const entry: QueueEntry = { id, targetKey, event, createdAt: Date.now() }
    await this.storage.put(`${this.prefix}${id}`, entry)
    return id
  }

  async getForTarget(targetKey: string): Promise<QueueEntry[]> {
    const keys = await this.storage.list(this.prefix)
    const entries: QueueEntry[] = []
    for (const key of keys) {
      const entry = await this.storage.get<QueueEntry>(key)
      if (entry && entry.targetKey === targetKey) {
        entries.push(entry)
      }
    }
    const sorted = entries.sort((a, b) => a.createdAt - b.createdAt)
    return sorted
  }

  async entries(): Promise<QueueEntry[]> {
    const keys = await this.storage.list(this.prefix)
    const entries: QueueEntry[] = []
    for (const key of keys) {
      const entry = await this.storage.get<QueueEntry>(key)
      if (entry) {
        entries.push(entry)
      }
    }
    return entries.sort((a, b) => a.createdAt - b.createdAt)
  }

  async removeForTarget(targetKey: string): Promise<void> {
    const keys = await this.storage.list(this.prefix)
    for (const key of keys) {
      const entry = await this.storage.get<QueueEntry>(key)
      if (entry && entry.targetKey === targetKey) {
        await this.storage.del(key)
      }
    }
  }

  async removeByTargetAndEventId(targetKey: string, eventId: string): Promise<void> {
    await this.remove(eventId + "/" + targetKey)
  }

  async remove(id: string): Promise<void> {
    await this.storage.del(`${this.prefix}${id}`)
  }
}
