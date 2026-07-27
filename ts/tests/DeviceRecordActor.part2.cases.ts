import { describe, expect, it, vi } from "vitest"
import { finalizeEvent, generateSecretKey, getPublicKey, type UnsignedEvent, type VerifiedEvent } from "nostr-tools"
import { Invite } from "../src/Invite"
import { MessageQueue } from "../src/MessageQueue"
import { Session } from "../src/Session"
import { buildTextRumor, buildTypingRumor } from "../src/messageBuilders"
import { InMemoryStorageAdapter } from "../src/StorageAdapter"
import { DeviceRecordActor } from "../src/session-manager/DeviceRecordActor"
import { createSessionFromAccept, decryptInviteResponse } from "../src/inviteUtils"
import type { NostrFacade, DeviceRecordUserHooks } from "../src/session-manager/types"
import type { NostrSubscribe, Rumor, SessionState } from "../src/types"
import { MockRelay } from "./helpers/mockRelay"

function createSubscribe(relay: MockRelay): NostrSubscribe {
  return (filter, onEvent) => {
    const handle = relay.subscribe(filter, onEvent)
    return handle.close
  }
}

function makeSession(
  name: string,
  {
    canSend,
    canReceive,
    sendingChainMessageNumber = 0,
    receivingChainMessageNumber = 0,
    previousSendingChainMessageCount = 0,
  }: {
    canSend: boolean
    canReceive: boolean
    sendingChainMessageNumber?: number
    receivingChainMessageNumber?: number
    previousSendingChainMessageCount?: number
  },
): Session {
  const ourCurrentPrivateKey = generateSecretKey()
  const ourNextPrivateKey = generateSecretKey()
  const theirCurrentPrivateKey = generateSecretKey()
  const theirNextPrivateKey = generateSecretKey()

  const state: SessionState = {
    rootKey: new Uint8Array(32).fill(1),
    theirCurrentNostrPublicKey: canReceive ? getPublicKey(theirCurrentPrivateKey) : undefined,
    theirNextNostrPublicKey: canSend
      ? getPublicKey(theirNextPrivateKey)
      : getPublicKey(theirCurrentPrivateKey),
    ourCurrentNostrKey: canSend
      ? {
          publicKey: getPublicKey(ourCurrentPrivateKey),
          privateKey: ourCurrentPrivateKey,
        }
      : undefined,
    ourNextNostrKey: {
      publicKey: getPublicKey(ourNextPrivateKey),
      privateKey: ourNextPrivateKey,
    },
    receivingChainKey: canReceive ? new Uint8Array(32).fill(2) : undefined,
    sendingChainKey: canSend ? new Uint8Array(32).fill(3) : undefined,
    sendingChainMessageNumber,
    receivingChainMessageNumber,
    previousSendingChainMessageCount,
    skippedKeys: {},
  }

  const session = new Session(state)
  session.name = name
  return session
}

async function waitForSessionMessage(
  session: { onEvent: (cb: (event: Rumor) => void) => () => void },
  text: string,
  timeoutMs = 10_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error(`Timed out waiting for session message "${text}"`))
    }, timeoutMs)

    const unsubscribe = session.onEvent((event) => {
      if (event.content != text) {
        return
      }
      clearTimeout(timeout)
      unsubscribe()
      resolve()
    })
  })
}

async function waitForSpyCall(
  assertion: () => void,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for assertion")
}

describe("DeviceRecordActor", () => {



it("promotes a decrypting inactive session and forwards its rumor before AppKeys catch up", async () => {
    const relay = new MockRelay()
    const subscribe = createSubscribe(relay)

    const deviceSecretKey = generateSecretKey()
    const devicePublicKey = getPublicKey(deviceSecretKey)
    const senderSecretKey = generateSecretKey()
    const senderPublicKey = getPublicKey(senderSecretKey)

    const invite = Invite.createNew(devicePublicKey, devicePublicKey, 1, {
      purpose: "chat",
      ownerPubkey: getPublicKey(generateSecretKey()),
    })

    const { session: senderSession, event: responseEvent } = await invite.accept(
      senderPublicKey,
      senderSecretKey,
      senderPublicKey,
    )

    const decrypted = await decryptInviteResponse({
      envelopeContent: responseEvent.content,
      envelopeSenderPubkey: responseEvent.pubkey,
      inviterEphemeralPrivateKey: invite.inviterEphemeralPrivateKey!,
      inviterPrivateKey: deviceSecretKey,
      sharedSecret: invite.sharedSecret,
    })

    const decryptingInactiveSession = createSessionFromAccept({
      theirPublicKey: decrypted.inviteeSessionPublicKey,
      ourSessionPrivateKey: invite.inviterEphemeralPrivateKey!,
      sharedSecret: invite.sharedSecret,
      isSender: false,
      name: responseEvent.id,
    })

    const establishedActiveSession = makeSession("established-active", {
      canSend: true,
      canReceive: true,
      sendingChainMessageNumber: 1,
      receivingChainMessageNumber: 1,
    })

    const messageQueue = new MessageQueue(
      new InMemoryStorageAdapter(),
      "v1/device-record-inactive-forward-test/",
    )

    const userHooks: DeviceRecordUserHooks = {
      isDeviceAuthorized: vi.fn(() => false),
      onDeviceRumor: vi.fn(),
      onDeviceDirty: vi.fn(),
    }

    const nostr: NostrFacade = {
      subscribe,
      publish: vi.fn(async (event: UnsignedEvent | VerifiedEvent) => {
        relay.storeAndDeliver(event as VerifiedEvent)
      }),
    }

    const actor = new DeviceRecordActor(devicePublicKey, {
      ownerPubkey: getPublicKey(generateSecretKey()),
      user: userHooks,
      nostr,
      messageQueue,
      ourDeviceId: senderPublicKey,
      ourOwnerPubkey: getPublicKey(generateSecretKey()),
      identityKey: senderSecretKey,
    })

    actor.installSession(establishedActiveSession)
    actor.installSession(decryptingInactiveSession, true)

    expect(actor.activeSession).toBe(establishedActiveSession)
    expect(actor.inactiveSessions).toContain(decryptingInactiveSession)

    const text = `inactive-session-forward-${Date.now()}`
    const { event } = senderSession.sendEvent(buildTextRumor(text))
    actor.processReceivedEvent(event)

    await waitForSpyCall(() => {
      expect(userHooks.onDeviceRumor).toHaveBeenCalledWith(
        devicePublicKey,
        expect.objectContaining({ content: text }),
        expect.objectContaining({ id: event.id }),
      )
    })
    expect(actor.activeSession).toBe(decryptingInactiveSession)
  })

it("does not open relay subscriptions for installed sessions", async () => {
    const relay = new MockRelay()
    let activeSubscriptions = 0
    const subscribe: NostrSubscribe = (filter, onEvent) => {
      const handle = relay.subscribe(filter, onEvent)
      activeSubscriptions += 1
      return () => {
        activeSubscriptions -= 1
        handle.close()
      }
    }

    const passiveSideSecretKey = generateSecretKey()
    const passiveSidePublicKey = getPublicKey(passiveSideSecretKey)
    const activeSideSecretKey = generateSecretKey()
    const activeSidePublicKey = getPublicKey(activeSideSecretKey)

    const invite = Invite.createNew(passiveSidePublicKey, passiveSidePublicKey, 1, {
      purpose: "link",
      ownerPubkey: passiveSidePublicKey,
    })

    const { event: responseEvent } = await invite.accept(
      activeSidePublicKey,
      activeSideSecretKey,
      activeSidePublicKey,
    )

    const decrypted = await decryptInviteResponse({
      envelopeContent: responseEvent.content,
      envelopeSenderPubkey: responseEvent.pubkey,
      inviterEphemeralPrivateKey: invite.inviterEphemeralPrivateKey!,
      inviterPrivateKey: passiveSideSecretKey,
      sharedSecret: invite.sharedSecret,
    })

    const passiveSession = createSessionFromAccept({
      theirPublicKey: decrypted.inviteeSessionPublicKey,
      ourSessionPrivateKey: invite.inviterEphemeralPrivateKey!,
      sharedSecret: invite.sharedSecret,
      isSender: false,
      name: responseEvent.id,
    })

    const messageQueue = new MessageQueue(
      new InMemoryStorageAdapter(),
      "v1/device-record-close-test/",
    )

    const userHooks: DeviceRecordUserHooks = {
      isDeviceAuthorized: vi.fn(() => true),
      onDeviceRumor: vi.fn(),
      onDeviceDirty: vi.fn(),
    }

    const nostr: NostrFacade = {
      subscribe,
      publish: vi.fn(async () => undefined as never),
    }

    const actor = new DeviceRecordActor(passiveSidePublicKey, {
      ownerPubkey: passiveSidePublicKey,
      user: userHooks,
      nostr,
      messageQueue,
      ourDeviceId: activeSidePublicKey,
      ourOwnerPubkey: activeSidePublicKey,
      identityKey: activeSideSecretKey,
    })

    actor.installSession(passiveSession)

    expect(activeSubscriptions).toBe(0)

    actor.close()

    expect(activeSubscriptions).toBe(0)
  })
});
