import type { StorageAdapter } from "../StorageAdapter.js"
import type { Session } from "../Session.js"
import { serializeSessionState } from "../utils.js"
import type {
  StoredSessionEntry,
  StoredUserRecord,
} from "./types.js"
import type { UserRecordActor } from "./UserRecordActor.js"

export class UserRecordStorage {
  private writeChain: Map<string, Promise<void>> = new Map()

  constructor(
    private readonly storage: StorageAdapter,
    private readonly versionPrefix: string,
  ) {}

  async storeUserRecord(
    publicKey: string,
    userRecord?: UserRecordActor,
  ): Promise<void> {
    const devices = Array.from(userRecord?.devices.entries() || [])
    const serializeSession = (session: Session): StoredSessionEntry => ({
      name: session.name,
      state: serializeSessionState(session.state),
    })

    const data: StoredUserRecord = {
      publicKey,
      devices: devices.map(([, device]) => ({
        deviceId: device.deviceId,
        activeSession: device.activeSession
          ? serializeSession(device.activeSession)
          : null,
        inactiveSessions: device.inactiveSessions.map(serializeSession),
        createdAt: device.createdAt,
      })),
      appKeys: userRecord?.appKeys?.serialize(),
      appKeysCreatedAt: userRecord?.appKeysCreatedAt,
    }

    const key = this.userRecordKey(publicKey)
    const previous = this.writeChain.get(key) || Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => this.storage.put(key, data))
    this.writeChain.set(key, next)
    return next
  }

  async loadUserRecord(publicKey: string): Promise<StoredUserRecord | undefined> {
    return this.storage.get<StoredUserRecord>(this.userRecordKey(publicKey))
  }

  async loadAllUserRecordPubkeys(): Promise<string[]> {
    const prefix = this.userRecordKeyPrefix()
    const keys = await this.storage.list(prefix)
    return keys.map((key) => key.slice(prefix.length))
  }

  async deleteUserData(publicKey: string): Promise<void> {
    await Promise.allSettled([
      this.deleteUserSessions(publicKey),
      this.storage.del(this.userRecordKey(publicKey)),
    ])
  }

  async runMigrations(): Promise<void> {
    let version = await this.storage.get<string>(this.versionKey())
    if (version) {
      return
    }

    const oldInvitePrefix = "invite/"
    const inviteKeys = await this.storage.list(oldInvitePrefix)
    await Promise.all(inviteKeys.map((key) => this.storage.del(key)))

    const oldUserRecordPrefix = "user/"
    const sessionKeys = await this.storage.list(oldUserRecordPrefix)
    await Promise.all(
      sessionKeys.map(async (key) => {
        try {
          const publicKey = key.slice(oldUserRecordPrefix.length)
          const userRecordData = await this.storage.get<StoredUserRecord>(key)
          if (!userRecordData) return

          const newUserRecordData: StoredUserRecord = {
            publicKey: userRecordData.publicKey,
            devices: userRecordData.devices.map((device) => ({
              deviceId: device.deviceId,
              activeSession: null,
              createdAt: device.createdAt,
              inactiveSessions: [],
            })),
          }
          await this.storage.put(this.userRecordKey(publicKey), newUserRecordData)
          await this.storage.del(key)
        } catch {
          // Ignore individual legacy record migration failures.
        }
      })
    )

    version = "1"
    await this.storage.put(this.versionKey(), version)
  }

  private async deleteUserSessions(publicKey: string): Promise<void> {
    const prefix = this.sessionKeyPrefix(publicKey)
    const keys = await this.storage.list(prefix)
    await Promise.all(keys.map((key) => this.storage.del(key)))
  }

  private sessionKeyPrefix(publicKey: string): string {
    return `${this.versionPrefix}/session/${publicKey}/`
  }

  private userRecordKey(publicKey: string): string {
    return `${this.userRecordKeyPrefix()}${publicKey}`
  }

  private userRecordKeyPrefix(): string {
    return `${this.versionPrefix}/user/`
  }

  private versionKey(): string {
    return "storage-version"
  }
}
