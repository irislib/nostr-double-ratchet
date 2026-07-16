import { Invite } from "../Invite.js"
import { Session } from "../Session.js"
import type { VerifiedEvent } from "nostr-tools"
import { buildTypingRumor } from "../messageBuilders.js"
import { INVITE_EVENT_KIND, type Rumor } from "../types.js"
import {
  compareSessionPriority,
  sessionCanReceive,
  sessionCanSend,
  sessionHasActivity,
  sessionPriority,
  sortedSendableSessionCandidates,
} from "./sessionSelection.js"
import type {
  DeviceRecord as DeviceRecordShape,
  DeviceRecordDeps,
  DeviceSetupState,
  Unsubscribe,
} from "./types.js"

export class DeviceRecordActor implements DeviceRecordShape {
  private static readonly MAX_INACTIVE_SESSIONS = 10

  public activeSession?: Session
  public inactiveSessions: Session[] = []
  public state: DeviceSetupState = "new"
  public createdAt: number

  private ensurePromise?: Promise<void>
  private inviteSubscription?: Unsubscribe
  private inviteAcceptancePromise?: Promise<Session>

  constructor(
    public readonly deviceId: string,
    private readonly deps: DeviceRecordDeps,
  ) {
    this.createdAt = deps.createdAt ?? Date.now()
  }

  private detachSession(session: Session): void {
    session.close()
  }

  private pruneDuplicateSessions(session: Session): void {
    if (this.activeSession && this.activeSession !== session && this.activeSession.name === session.name) {
      const staleActive = this.activeSession
      this.activeSession = undefined
      this.detachSession(staleActive)
    }

    const staleInactive = this.inactiveSessions.filter(
      (candidate) => candidate !== session && candidate.name === session.name
    )
    this.inactiveSessions = this.inactiveSessions.filter(
      (candidate) => candidate === session || candidate.name !== session.name
    )
    for (const staleSession of staleInactive) {
      this.detachSession(staleSession)
    }

  }

  hasEstablishedActiveSession(): boolean {
    if (!this.activeSession) {
      return false
    }

    return (
      sessionCanSend(this.activeSession) &&
      (
        sessionCanReceive(this.activeSession) ||
        sessionHasActivity(this.activeSession)
      )
    )
  }

  ensureSetup(): Promise<void> {
    if (this.state === "revoked") {
      return Promise.resolve()
    }
    if (this.state === "session-ready") {
      return this.flushMessageQueue().catch(() => {})
    }
    if (this.ensurePromise) {
      return this.ensurePromise
    }

    this.ensurePromise = this.doEnsureSetup().finally(() => {
      this.ensurePromise = undefined
    })
    return this.ensurePromise
  }

  private async doEnsureSetup(): Promise<void> {
    if (this.state === "revoked") return

    if (this.activeSession) {
      this.state = "session-ready"
      await this.flushMessageQueue()
      return
    }

    if (this.inactiveSessions.length > 0) {
      this.ensureInviteSubscription()
      this.state = "waiting-for-invite"
      return
    }

    if (this.deviceId === this.deps.ourDeviceId) {
      return
    }

    this.ensureInviteSubscription()
    this.state = "waiting-for-invite"
  }

  private ensureInviteSubscription(): void {
    if (this.inviteSubscription || this.state === "revoked") {
      return
    }

    this.inviteSubscription = this.deps.nostr.subscribe(
      `device-invite-${this.deviceId}`,
      {
        kinds: [INVITE_EVENT_KIND],
        authors: [this.deviceId],
        "#l": ["double-ratchet/invites"],
      },
      (event) => {
        try {
          const invite = Invite.fromEvent(event)
          this.acceptInvite(invite).catch(() => {})
        } catch {
          // Ignore invalid invite events.
        }
      }
    )
  }

  acceptInvite(invite: Invite): Promise<Session> {
    if (this.state === "revoked") {
      return Promise.reject(new Error("Device is revoked"))
    }

    const inviteDeviceId = invite.deviceId || invite.inviter
    if (inviteDeviceId !== this.deviceId) {
      return Promise.reject(new Error("Invite does not target this device"))
    }

    if (this.hasEstablishedActiveSession()) {
      return Promise.resolve(this.activeSession!)
    }

    if (this.inviteAcceptancePromise) {
      return this.inviteAcceptancePromise
    }

    this.inviteAcceptancePromise = this.doAcceptInvite(invite).finally(() => {
      this.inviteAcceptancePromise = undefined
    })

    return this.inviteAcceptancePromise
  }

  private async doAcceptInvite(invite: Invite): Promise<Session> {
    this.state = "accepting-invite"

    try {
      const identityKey = this.deps.identityKey
      const encryptor = identityKey instanceof Uint8Array ? identityKey : identityKey.encrypt

      const { session, event } = await invite.accept(
        this.deps.ourDeviceId,
        encryptor,
        this.deps.ourOwnerPubkey
      )
      this.installSession(session, false, { preferActive: true })
      await this.deps.nostr.publish(event)
      await this.publishInviteBootstrap(session)
      this.state = "session-ready"
      await this.flushMessageQueue()
      return session
    } catch (error) {
      this.state = "waiting-for-invite"
      throw error
    }
  }

  private async publishInviteBootstrap(session: Session): Promise<void> {
    try {
      const { event } = session.sendEvent(
        buildTypingRumor({
          expiration: { expiresAt: Math.floor(Date.now() / 1000) },
        }),
        [["p", this.deviceId]],
      )
      await this.deps.nostr.publish(event)
    } catch {
      // Invite acceptance itself already established the session. If the bootstrap
      // cannot be published, queued messages will still flush on the next inbound event.
    }
  }

  private promoteToActive(
    nextSession: Session,
    options: { force?: boolean; preferActive?: boolean } = {},
  ): void {
    const { force = false, preferActive = false } = options
    const current = this.activeSession
    if (current === nextSession || current?.name === nextSession.name) {
      this.activeSession = nextSession
      this.inactiveSessions = this.inactiveSessions.filter(
        (s) => s !== nextSession && s.name !== nextSession.name
      )
      return
    }

    this.inactiveSessions = this.inactiveSessions.filter(
      (s) => s !== nextSession && s.name !== nextSession.name
    )

    if (force) {
      if (current) {
        this.inactiveSessions.unshift(current)
      }
      this.activeSession = nextSession
      this.trimInactiveSessions()
      return
    }

    const shouldReplaceUnestablishedActive =
      preferActive &&
      current &&
      !this.hasEstablishedActiveSession()

    if (shouldReplaceUnestablishedActive) {
      this.inactiveSessions.unshift(current)
      this.activeSession = nextSession
    } else if (
      current &&
      compareSessionPriority(
        sessionPriority(current),
        sessionPriority(nextSession),
      ) >= 0
    ) {
      this.inactiveSessions.unshift(nextSession)
      this.activeSession = current
    } else {
      if (current) {
        this.inactiveSessions.unshift(current)
      }
      this.activeSession = nextSession
    }
    this.trimInactiveSessions()
  }

  private sendEventWithBestSession(rumor: Rumor): VerifiedEvent | undefined {
    for (const candidate of sortedSendableSessionCandidates(
      this.activeSession,
      this.inactiveSessions,
    )) {
      try {
        const { event } = candidate.session.sendEvent(rumor, [["p", this.deviceId]])
        if (!candidate.active) {
          this.promoteToActive(candidate.session, { force: true })
        }
        return event
      } catch {
        // Try the next send-capable session.
      }
    }

    return undefined
  }

  prepareOutboundEvent(rumor: Rumor): VerifiedEvent | undefined {
    if (this.state === "revoked") {
      return undefined
    }
    return this.sendEventWithBestSession(rumor)
  }

  private handleSessionRumor(
    session: Session,
    event: Rumor,
    outerEvent?: VerifiedEvent,
  ): boolean {
    const owner = this.deps.ownerPubkey
    const isKnownInstalledSession =
      this.activeSession?.name === session.name ||
      this.inactiveSessions.some((s) => s === session || s.name === session.name)
    const isAuthorizedDevice =
      owner === this.deviceId ||
      this.deps.user.isDeviceAuthorized(this.deviceId) ||
      isKnownInstalledSession
    if (!isAuthorizedDevice) {
      return false
    }

    // A session that successfully decrypts a rumor is the live session, even if
    // AppKeys propagation or previous priority ordering has not caught up yet.
    this.promoteToActive(session, { force: true })
    this.deps.user.onDeviceRumor(this.deviceId, event, outerEvent)
    this.state = "session-ready"
    this.flushMessageQueue().catch(() => {})
    this.deps.user.onDeviceDirty()
    return true
  }

  processReceivedEvent(event: VerifiedEvent): boolean {
    const sessions: Session[] = []
    if (this.activeSession) {
      sessions.push(this.activeSession)
    }
    sessions.push(...this.inactiveSessions)

    const seenSessionNames = new Set<string>()
    for (const session of sessions) {
      if (seenSessionNames.has(session.name)) {
        continue
      }
      seenSessionNames.add(session.name)

      let rumor: Rumor | undefined
      try {
        rumor = session.receiveEvent(event)
      } catch {
        continue
      }
      if (rumor && this.handleSessionRumor(session, rumor, event)) {
        return true
      }
    }

    return false
  }

  installSession(
    session: Session,
    inactive = false,
    options: { persist?: boolean; preferActive?: boolean } = {}
  ): void {
    const { persist = true, preferActive = false } = options
    this.pruneDuplicateSessions(session)

    if (inactive) {
      const exists = this.inactiveSessions.some(
        (s) => s === session || s.name === session.name
      )
      if (!exists) {
        this.inactiveSessions.unshift(session)
        this.trimInactiveSessions()
      }
    } else {
      this.promoteToActive(session, { preferActive })
    }

    if (this.activeSession) {
      this.state = "session-ready"
    }

    if (persist) {
      this.deps.user.onDeviceDirty()
    }
  }

  private trimInactiveSessions(): void {
    if (this.inactiveSessions.length <= DeviceRecordActor.MAX_INACTIVE_SESSIONS) {
      return
    }
    const removed = this.inactiveSessions.splice(DeviceRecordActor.MAX_INACTIVE_SESSIONS)
    for (const session of removed) {
      this.detachSession(session)
    }
  }

  async flushMessageQueue(): Promise<void> {
    if (this.state === "revoked") {
      return
    }

    const entries = await this.deps.messageQueue.getForTarget(this.deviceId)
    if (entries.length === 0) {
      return
    }

    for (const entry of entries) {
      const event = this.prepareOutboundEvent(entry.event)
      if (!event) {
        continue
      }
      try {
        await this.deps.nostr.publish(event)
        await this.deps.messageQueue.removeByTargetAndEventId(this.deviceId, entry.event.id)
      } catch {
        // Keep entry for future retry.
      }
    }

    this.deps.user.onDeviceDirty()
  }

  deactivateCurrentSession(): void {
    if (!this.activeSession) return
    this.inactiveSessions.push(this.activeSession)
    this.activeSession = undefined
    this.state = "waiting-for-invite"
    this.deps.user.onDeviceDirty()
  }

  async revoke(): Promise<void> {
    this.state = "revoked"
    this.close()
    this.activeSession = undefined
    this.inactiveSessions = []
    await this.deps.messageQueue.removeForTarget(this.deviceId).catch(() => {})
    this.deps.user.onDeviceDirty()
  }

  close(): void {
    this.inviteSubscription?.()
    this.inviteSubscription = undefined

    const sessions = new Set<Session>()
    if (this.activeSession) {
      sessions.add(this.activeSession)
    }
    for (const session of this.inactiveSessions) {
      sessions.add(session)
    }
    for (const session of sessions) {
      this.detachSession(session)
    }
  }
}
