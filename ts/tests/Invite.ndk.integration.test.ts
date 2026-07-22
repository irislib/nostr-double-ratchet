import NDK, {
  NDKEvent,
  type NDKFilter,
  NDKRelayStatus,
} from '@nostr-dev-kit/ndk'
import { generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools'
import ws from 'ws'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Invite } from '../src/Invite'
import { buildTextRumor } from '../src/messageBuilders'
import { Session } from '../src/Session'
import { MESSAGE_EVENT_KIND, type Rumor } from '../src/types'
import {
  createEventStream,
  deserializeSessionState,
  serializeSessionState,
} from '../src/utils'

if (typeof global.WebSocket === 'undefined') {
  global.WebSocket = ws
}

const DEFAULT_RELAYS = [
  'wss://temp.iris.to',
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://relay.snort.social',
]

const connectedRelayCount = (ndk: NDK) =>
  Array.from(ndk.pool.relays.values()).filter(
    (relay) => relay.status === NDKRelayStatus.CONNECTED,
  ).length

const waitForRelayConnection = async (ndk: NDK, name: string) => {
  const deadline = Date.now() + 8_000
  while (connectedRelayCount(ndk) === 0) {
    if (Date.now() >= deadline) {
      throw new Error(`${name} did not connect to any relay within 8000ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const createNdkSubscribe = (ndk: NDK) => {
  const seenIds = new Set<string>()
  return (filter: NDKFilter, onEvent: (event: VerifiedEvent) => void) => {
    const subscription = ndk.subscribe(filter, { groupable: false })
    subscription.on('event', (event: NDKEvent) => {
      if (!event.id || seenIds.has(event.id)) return
      seenIds.add(event.id)
      onEvent(event as unknown as VerifiedEvent)
    })
    return () => subscription.stop()
  }
}

const subscribeSession = (
  session: Session,
  nostrSubscribe: ReturnType<typeof createNdkSubscribe>,
) => {
  const authors = new Set<string>()
  const unsubscribers: Array<() => void> = []

  const subscribeKnownAuthors = () => {
    for (const author of [
      session.state.theirCurrentNostrPublicKey,
      session.state.theirNextNostrPublicKey,
    ]) {
      if (!author || authors.has(author)) continue
      authors.add(author)
      unsubscribers.push(
        nostrSubscribe(
          { kinds: [MESSAGE_EVENT_KIND], authors: [author] },
          (event) => {
            session.receiveEvent(event)
            subscribeKnownAuthors()
          },
        ),
      )
    }
  }

  subscribeKnownAuthors()
  return () => unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
}

const publishEvent = async (ndk: NDK, event: VerifiedEvent) => {
  await new NDKEvent(ndk, event).publish()
}

const nextRumor = async (
  stream: AsyncGenerator<Rumor, void, unknown>,
  timeoutMessage: string,
) => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      stream.next(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), 10_000)
      }),
    ])
    if (result.done) throw new Error('session event stream ended')
    return result.value
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

const sendAndReceive = async (
  sender: Session,
  senderNdk: NDK,
  receiver: AsyncGenerator<Rumor, void, unknown>,
  content: string,
) => {
  const received = nextRumor(receiver, `timed out waiting for: ${content}`)
  await publishEvent(senderNdk, sender.sendEvent(buildTextRumor(content)).event)
  expect((await received).content).toBe(content)
}

describe('Invite NDK Integration', () => {
  let aliceNdk: NDK
  let bobNdk: NDK
  let alicePrivateKey: Uint8Array
  let alicePublicKey: string
  let bobPrivateKey: Uint8Array
  let bobPublicKey: string
  const testUnsubscribers: Array<() => void> = []

  beforeAll(async () => {
    alicePrivateKey = generateSecretKey()
    alicePublicKey = getPublicKey(alicePrivateKey)
    bobPrivateKey = generateSecretKey()
    bobPublicKey = getPublicKey(bobPrivateKey)

    aliceNdk = new NDK({ explicitRelayUrls: DEFAULT_RELAYS, enableOutboxModel: true })
    bobNdk = new NDK({ explicitRelayUrls: DEFAULT_RELAYS, enableOutboxModel: true })

    void aliceNdk.connect(8_000)
    void bobNdk.connect(8_000)
    await Promise.all([
      waitForRelayConnection(aliceNdk, 'Alice'),
      waitForRelayConnection(bobNdk, 'Bob'),
    ])
  }, 10_000)

  afterEach(() => {
    testUnsubscribers.splice(0).forEach((unsubscribe) => unsubscribe())
  })

  afterAll(() => {
    for (const relay of aliceNdk.pool.relays.values()) relay.disconnect()
    for (const relay of bobNdk.pool.relays.values()) relay.disconnect()
  })

  const establishSessions = async (
    invite: Invite,
    acceptedInvite: Invite = invite,
  ) => {
    const aliceSubscribe = createNdkSubscribe(aliceNdk)
    const bobSubscribe = createNdkSubscribe(bobNdk)
    let unsubscribeAliceSession = () => {}

    const aliceSessionPromise = new Promise<Session>((resolve) => {
      testUnsubscribers.push(
        invite.listen(alicePrivateKey, aliceSubscribe, (session: Session) => {
          unsubscribeAliceSession = subscribeSession(session, aliceSubscribe)
          testUnsubscribers.push(unsubscribeAliceSession)
          resolve(session)
        }),
      )
    })

    const { session: bobSession, event } = await acceptedInvite.accept(
      bobPublicKey,
      bobPrivateKey,
    )
    testUnsubscribers.push(subscribeSession(bobSession, bobSubscribe))
    await publishEvent(bobNdk, event)

    return {
      aliceSession: await aliceSessionPromise,
      aliceSubscribe,
      bobSession,
      unsubscribeAliceSession,
    }
  }

  it('should handle invite creation, acceptance, and bidirectional messaging over NDK', async () => {
    const invite = Invite.createNew(alicePublicKey)
    const parsedInvite = Invite.fromUrl(invite.getUrl())
    expect(parsedInvite.inviterEphemeralPublicKey).toBe(
      invite.inviterEphemeralPublicKey,
    )
    expect(parsedInvite.sharedSecret).toBe(invite.sharedSecret)
    expect(parsedInvite.inviter).toBe(invite.inviter)

    const { aliceSession, bobSession } = await establishSessions(
      invite,
      parsedInvite,
    )
    const aliceMessages = createEventStream(aliceSession)
    const bobMessages = createEventStream(bobSession)

    await sendAndReceive(bobSession, bobNdk, aliceMessages, 'Hello Alice from Bob!')
    await sendAndReceive(aliceSession, aliceNdk, bobMessages, 'Hi Bob from Alice!')
    await sendAndReceive(bobSession, bobNdk, aliceMessages, 'How are you doing?')
    await sendAndReceive(aliceSession, aliceNdk, bobMessages, "I'm doing great, thanks!")
  }, 30_000)

  it('should handle session state persistence and message delivery after reconnection', async () => {
    const {
      aliceSession,
      aliceSubscribe,
      bobSession,
      unsubscribeAliceSession,
    } = await establishSessions(Invite.createNew(alicePublicKey))
    const aliceMessages = createEventStream(aliceSession)

    await sendAndReceive(
      bobSession,
      bobNdk,
      aliceMessages,
      'Message before reconnection',
    )

    const serializedState = serializeSessionState(aliceSession.state)
    unsubscribeAliceSession()
    aliceSession.close()

    const restoredAliceSession = new Session(
      deserializeSessionState(serializedState),
    )
    testUnsubscribers.push(
      subscribeSession(restoredAliceSession, aliceSubscribe),
    )
    const restoredMessages = createEventStream(restoredAliceSession)

    await sendAndReceive(
      bobSession,
      bobNdk,
      restoredMessages,
      'Message after Alice reconnection',
    )
  }, 20_000)
})
