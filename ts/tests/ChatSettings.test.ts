import { afterEach, describe, expect, it, vi } from "vitest"
import { EXPIRATION_TAG, CHAT_SETTINGS_KIND } from "../src/types"
import { createMockSessionManager } from "./helpers/mockSessionManager"
import { MockRelay } from "./helpers/mockRelay"

const FIXED_TIMESTAMP_MS = 1704067200000 // 2024-01-01 00:00:00 UTC

describe("Chat settings (disappearing message signaling)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("SessionManager.sendMessage should never add expiration to chat settings kind 10448", async () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXED_TIMESTAMP_MS)

    const sharedRelay = new MockRelay()
    const { manager: aliceManager } = await createMockSessionManager("alice-device-1", sharedRelay)
    const { publicKey: bobPubkey } = await createMockSessionManager("bob-device-1", sharedRelay)

    await aliceManager.setDefaultExpiration({ ttlSeconds: 60 })

    const rumor = await aliceManager.sendMessage(bobPubkey, JSON.stringify({
      type: "chat-settings",
      v: 1,
      messageTtlSeconds: 120,
    }), {
      kind: CHAT_SETTINGS_KIND,
    })

    expect(rumor.kind).toBe(CHAT_SETTINGS_KIND)
    expect(rumor.tags.some(([k]) => k === EXPIRATION_TAG)).toBe(false)
  })

  it("receiver should auto-adopt chat-settings and apply ttl to outgoing messages", async () => {
    vi.spyOn(Date, "now").mockReturnValue(FIXED_TIMESTAMP_MS)

    const sharedRelay = new MockRelay()
    const { manager: aliceManager, publicKey: alicePubkey } = await createMockSessionManager(
      "alice-device-1",
      sharedRelay
    )
    const { manager: bobManager, publicKey: bobPubkey } = await createMockSessionManager(
      "bob-device-1",
      sharedRelay
    )

    const ttlSeconds = 90
    const expectedExpiresAt = Math.floor(FIXED_TIMESTAMP_MS / 1000) + ttlSeconds

    const gotSettings = new Promise<void>((resolve) => {
      bobManager.onEvent((event) => {
        if (event.kind === CHAT_SETTINGS_KIND) resolve()
      })
    })

    await aliceManager.sendMessage(bobPubkey, JSON.stringify({
      type: "chat-settings",
      v: 1,
      messageTtlSeconds: ttlSeconds,
    }), {
      kind: CHAT_SETTINGS_KIND,
    })

    await gotSettings

    const received = new Promise<string[][]>((resolve) => {
      aliceManager.onEvent((event) => {
        if (event.content === "after-settings") resolve(event.tags)
      })
    })

    await bobManager.sendMessage(alicePubkey, "after-settings")

    const tags = await received
    expect(tags).toContainEqual([EXPIRATION_TAG, String(expectedExpiresAt)])
  })

  it(
    "a remote peer cannot disable expiration for another conversation with a forged p tag",
    async () => {
      vi.spyOn(Date, "now").mockReturnValue(FIXED_TIMESTAMP_MS)
      const relay = new MockRelay()
      const alice = await createMockSessionManager("alice", relay)
      const bob = await createMockSessionManager("bob", relay)
      const mallory = await createMockSessionManager("mallory", relay)
      await alice.manager.setExpirationForPeer(bob.publicKey, { ttlSeconds: 60 })

      const received = new Promise<void>((resolve) => {
        alice.manager.onEvent((event, from) => {
          if (event.kind === CHAT_SETTINGS_KIND && from === mallory.publicKey) resolve()
        })
      })
      await mallory.manager.sendMessage(alice.publicKey, JSON.stringify({
        type: "chat-settings",
        v: 1,
        messageTtlSeconds: null,
      }), {
        kind: CHAT_SETTINGS_KIND,
        tags: [["p", bob.publicKey], ["p", alice.publicKey]],
      })
      await received

      const outgoing = await alice.manager.sendMessage(bob.publicKey, "still disappearing")
      expect(outgoing.tags).toContainEqual([
        EXPIRATION_TAG,
        String(Math.floor(FIXED_TIMESTAMP_MS / 1000) + 60),
      ])
    },
  )

  it(
    "auto-adopt should also sync settings across the sender's own devices (uses p-tag peer)",
    async () => {
      vi.spyOn(Date, "now").mockReturnValue(FIXED_TIMESTAMP_MS)

      const sharedRelay = new MockRelay()

      const alice1 = await createMockSessionManager("alice-device-1", sharedRelay)
      const alice2 = await createMockSessionManager(
        "alice-device-2",
        sharedRelay,
        alice1.secretKey
      )
      const bob = await createMockSessionManager("bob-device-1", sharedRelay)

      const ttlSeconds = 45
      const expectedExpiresAt = Math.floor(FIXED_TIMESTAMP_MS / 1000) + ttlSeconds

      const gotSettingsOnAlice2 = new Promise<void>((resolve) => {
        alice2.manager.onEvent((event) => {
          if (event.kind === CHAT_SETTINGS_KIND) resolve()
        })
      })

      // alice1 sends settings to bob; alice2 should receive a copy and adopt for bob (via p-tag)
      await alice1.manager.sendMessage(
        bob.publicKey,
        JSON.stringify({
          type: "chat-settings",
          v: 1,
          messageTtlSeconds: ttlSeconds,
        }),
        { kind: CHAT_SETTINGS_KIND }
      )

      await gotSettingsOnAlice2

      const received = new Promise<string[][]>((resolve) => {
        bob.manager.onEvent((event) => {
          if (event.content === "from-alice2") resolve(event.tags)
        })
      })

      await alice2.manager.sendMessage(bob.publicKey, "from-alice2")

      const tags = await received
      expect(tags).toContainEqual([EXPIRATION_TAG, String(expectedExpiresAt)])
    },
    15000
  )
})
