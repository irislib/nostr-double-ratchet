import { afterEach, describe, expect, it, vi } from "vitest"

import { LocalStorageAdapter } from "../src/StorageAdapter"
import { RuntimeState } from "../src/RuntimeState"

describe("LocalStorageAdapter fail-closed reads", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("does not turn a corrupt canonical snapshot into absent state", async () => {
    const setItem = vi.fn()
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "{not-json"),
      setItem,
      removeItem: vi.fn(),
      key: vi.fn(() => null),
      length: 1,
    })

    const state = new RuntimeState(new LocalStorageAdapter())
    await expect(state.init()).rejects.toThrow()
    expect(setItem).not.toHaveBeenCalled()
  })

  it("propagates list access failures during migration", async () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      key: vi.fn(() => null),
      get length() {
        throw new Error("storage denied")
      },
    })

    await expect(new RuntimeState(new LocalStorageAdapter()).init())
      .rejects.toThrow("storage denied")
  })
})
