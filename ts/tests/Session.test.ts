import { describe, expect, it } from "vitest"
import { generateSecretKey, getPublicKey, type VerifiedEvent } from "nostr-tools"
import { Session } from "../src/Session"
import {
  buildReactionRumor,
  buildReplyRumor,
  buildTextRumor,
} from "../src/messageBuilders"
import {
  CHAT_MESSAGE_KIND,
  MESSAGE_EVENT_KIND,
  REACTION_KIND,
} from "../src/types"
import {
  deserializeSessionState,
  isReaction,
  parseReaction,
  serializeSessionState,
} from "../src/utils"

const sharedSecret = () => new Uint8Array()

function createPair() {
  const aliceSecretKey = generateSecretKey()
  const bobSecretKey = generateSecretKey()
  const alice = Session.init(
    getPublicKey(bobSecretKey),
    aliceSecretKey,
    true,
    sharedSecret(),
    "alice",
  )
  const bob = Session.init(
    getPublicKey(aliceSecretKey),
    bobSecretKey,
    false,
    sharedSecret(),
    "bob",
  )
  return { alice, bob, aliceSecretKey, bobSecretKey }
}

function deliver(receiver: Session, event: VerifiedEvent) {
  const rumor = receiver.receiveEvent(event)
  expect(rumor).toBeTruthy()
  return rumor!
}

function sendText(session: Session, text: string) {
  return session.sendEvent(buildTextRumor(text))
}

describe("Session", () => {
  it("initializes with correct properties", () => {
    const bobSecretKey = generateSecretKey()
    const aliceSecretKey = generateSecretKey()
    const alice = Session.init(
      getPublicKey(bobSecretKey),
      aliceSecretKey,
      true,
      sharedSecret(),
    )

    expect(alice.state.theirNextNostrPublicKey).toBe(getPublicKey(bobSecretKey))
    expect(alice.state.ourCurrentNostrKey!.publicKey).toBe(getPublicKey(aliceSecretKey))
    expect(alice.state.ourCurrentNostrKey!.publicKey).toHaveLength(64)
  })

  it("creates an encrypted message event", () => {
    const { alice } = createPair()
    const { event } = sendText(alice, "Hello, world!")

    expect(event.kind).toBe(MESSAGE_EVENT_KIND)
    expect(event.tags[0][0]).toEqual("header")
    expect(event.tags[0][1]).toBeTruthy()
    expect(event.content).toBeTruthy()
    expect(event.pubkey).toHaveLength(64)
    expect(event.id).toHaveLength(64)
    expect(event.sig).toHaveLength(128)
  })

  it("decrypts fed events and updates ratchet keys", async () => {
    const { alice, bob } = createPair()
    const initialReceivingChainKey = bob.state.receivingChainKey

    const bobFirstMessage = deliver(bob, sendText(alice, "Hello, Bob!").event)
    expect(bobFirstMessage.content).toBe("Hello, Bob!")
    expect(bob.state.receivingChainKey).not.toBe(initialReceivingChainKey)
  })

  it("rejects extended inner rumors without advancing receive state", () => {
    const { alice, bob } = createPair()
    const before = serializeSessionState(bob.state)
    const extended = {
      ...buildTextRumor("unexpected field"),
      unexpected: true,
    }
    const { event } = alice.sendEvent(extended)

    expect(() => bob.receiveEvent(event)).toThrow("Invalid Double Ratchet inner rumor")
    expect(serializeSessionState(bob.state)).toBe(before)
  })

  it("handles multiple back-and-forth messages", async () => {
    const { alice, bob } = createPair()

    const sendAndExpect = async (
      sender: Session,
      receiver: Session,
      message: string,
    ) => {
      const initialSendingChainKey = sender.state.sendingChainKey
      const initialReceivingChainKey = receiver.state.receivingChainKey

      const receivedMessage = deliver(receiver, sendText(sender, message).event)

      expect(receivedMessage.content).toBe(message)
      expect(sender.state.sendingChainKey).not.toBe(initialSendingChainKey)
      expect(receiver.state.receivingChainKey).not.toBe(initialReceivingChainKey)
    }

    await sendAndExpect(alice, bob, "Hello Bob!")
    await sendAndExpect(bob, alice, "Hi Alice!")
    await sendAndExpect(alice, bob, "How are you?")
    await sendAndExpect(bob, alice, "I am fine, thank you!")
    await sendAndExpect(bob, alice, "How about you?")
    await sendAndExpect(alice, bob, "I'm doing great, thanks!")
  })

  it("handles out-of-order delivery with skipped keys", async () => {
    const { alice, bob } = createPair()

    const message1 = sendText(alice, "Message 1").event
    const message2 = sendText(alice, "Message 2").event
    const message3 = sendText(alice, "Message 3").event

    expect(deliver(bob, message3).content).toBe("Message 3")

    expect(deliver(bob, message1).content).toBe("Message 1")

    expect(deliver(bob, message2).content).toBe("Message 2")
  })

  it("decrypts same-chain follow-ups from the previously advertised next author", () => {
    const { alice, bob } = createPair()

    const message1 = sendText(alice, "Message 1").event
    const advertisedNext = alice.state.ourNextNostrKey
    expect(deliver(bob, message1).content).toBe("Message 1")

    const nextPrivateKey = generateSecretKey()
    alice.state.ourCurrentNostrKey = advertisedNext
    alice.state.ourNextNostrKey = {
      publicKey: getPublicKey(nextPrivateKey),
      privateKey: nextPrivateKey,
    }

    const message2 = sendText(alice, "Message 2").event
    expect(message2.pubkey).toBe(advertisedNext.publicKey)
    expect(deliver(bob, message2).content).toBe("Message 2")
  })

  it.each(["initiator", "responder"])("decrypts delayed %s messages after a ratchet and restore", (role) => {
    const { alice, bob } = createPair()
    deliver(bob, sendText(alice, "Initialize").event)
    const [sender, receiver] = role === "initiator" ? [alice, bob] : [bob, alice]
    deliver(receiver, sendText(sender, "First message").event)
    const delayed = sendText(sender, "Delayed message").event

    deliver(sender, sendText(receiver, "Reply").event)
    deliver(receiver, sendText(sender, "New chain").event)

    const restored = new Session(deserializeSessionState(serializeSessionState(receiver.state)))
    expect(deliver(restored, delayed).content).toBe("Delayed message")
    expect(restored.receiveEvent(delayed)).toBeUndefined()
    expect(deliver(sender, sendText(restored, "Still connected").event).content)
      .toBe("Still connected")
  })

  it("maintains conversation state through serialization", async () => {
    const { alice, bob } = createPair()

    expect(deliver(bob, sendText(alice, "Hello Bob!").event).content).toBe("Hello Bob!")

    expect(deliver(alice, sendText(bob, "Hi Alice!").event).content).toBe("Hi Alice!")

    const aliceRestored = new Session(deserializeSessionState(serializeSessionState(alice.state)))
    const bobRestored = new Session(deserializeSessionState(serializeSessionState(bob.state)))

    expect(deliver(bobRestored, sendText(aliceRestored, "How are you?").event).content)
      .toBe("How are you?")

    expect(deliver(aliceRestored, sendText(bobRestored, "Doing great!").event).content)
      .toBe("Doing great!")
  })

  it("discards duplicate messages after restoring", () => {
    const { alice, bob } = createPair()
    const sentEvents = [
      sendText(alice, "Message 1").event,
      sendText(alice, "Message 2").event,
      sendText(alice, "Message 3").event,
    ]

    for (const event of sentEvents) {
      deliver(bob, event)
    }

    const bobRestored = new Session(deserializeSessionState(serializeSessionState(bob.state)))
    const initialReceivingCount = bobRestored.state.receivingChainMessageNumber

    for (const event of sentEvents) {
      expect(bobRestored.receiveEvent(event)).toBeUndefined()
    }

    expect(bobRestored.state.receivingChainMessageNumber).toBe(initialReceivingCount)
  })

  it("sends and receives reactions", async () => {
    const { alice, bob } = createPair()

    const { event: messageEvent, innerEvent: messageInner } = sendText(alice, "Hello Bob!")
    expect(deliver(bob, messageEvent).content).toBe("Hello Bob!")

    const { event: reactionEvent, innerEvent: reactionInner } =
      bob.sendEvent(buildReactionRumor(messageInner.id, "👍"))

    expect(reactionInner.kind).toBe(REACTION_KIND)
    expect(reactionInner.tags).toContainEqual(["e", messageInner.id])
    expect(reactionInner.content).toBe("👍")
    expect(isReaction(reactionInner)).toBe(true)
    expect(parseReaction(reactionInner)?.emoji).toBe("👍")

    const aliceReaction = deliver(alice, reactionEvent)
    expect(isReaction(aliceReaction)).toBe(true)
    expect(parseReaction(aliceReaction)?.messageId).toBe(messageInner.id)
  })

  it("identifies reaction vs regular messages", () => {
    const reactionRumor = { kind: REACTION_KIND, content: "❤️", tags: [["e", "abc123"]] }
    expect(isReaction(reactionRumor)).toBe(true)
    expect(parseReaction(reactionRumor)?.type).toBe("reaction")
    expect(parseReaction(reactionRumor)?.messageId).toBe("abc123")
    expect(parseReaction(reactionRumor)?.emoji).toBe("❤️")

    expect(isReaction({ kind: 14, content: "Hello world", tags: [] })).toBe(false)
    expect(parseReaction({ kind: 1, content: "👍", tags: [["e", "abc123"]] })).toBeNull()
  })

  it("sends and receives replies", async () => {
    const { alice, bob } = createPair()

    const { event: messageEvent, innerEvent: messageInner } = sendText(alice, "Hello Bob!")
    deliver(bob, messageEvent)

    const { event: replyEvent, innerEvent: replyInner } =
      bob.sendEvent(buildReplyRumor("Hey Alice, great to hear from you!", messageInner.id))

    expect(replyInner.kind).toBe(CHAT_MESSAGE_KIND)
    expect(replyInner.tags).toContainEqual(["e", messageInner.id])

    const aliceReply = deliver(alice, replyEvent)
    expect(aliceReply.content).toBe("Hey Alice, great to hear from you!")
    expect(aliceReply.kind).toBe(CHAT_MESSAGE_KIND)
  })
})
