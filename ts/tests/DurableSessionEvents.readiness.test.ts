import { expect, it, vi } from 'vitest'
import { DurableSessionEvents } from '../src/session-manager/durableSessionEvents.js'
import type { StoredDurableSessionEvent } from '../src/session-manager/types.js'

const entry = (id: string): StoredDurableSessionEvent => ({ id, sender: 'sender', meta: {},
  event: { id, pubkey: 'sender', kind: 21113, content: '', tags: [], created_at: 1 } })

it('coalesces a readiness change during an active drain without losing the followup', async () => {
  const first = { publicKey: 'first', pendingDurableEvents: new Map([['first', entry('first')]]) }
  const second = { publicKey: 'second', pendingDurableEvents: new Map([['second', entry('second')]]) }
  const inbox = new DurableSessionEvents(() => [first, second], async () => {})
  let ready = false, firstAttempts = 0, secondAttempts = 0
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  inbox.onEvent([21113], async event => {
    if (event.id === 'first') {
      firstAttempts++
      if (!ready) throw new Error('sender keys not ready')
    } else { secondAttempts++; await blocked }
  })
  try {
    await vi.waitFor(() => expect(secondAttempts).toBe(1))
    expect(firstAttempts).toBe(1)
    ready = true
    inbox.notifyReady()
    inbox.notifyReady()
    release()
    await vi.waitFor(() => expect(first.pendingDurableEvents.size + second.pendingDurableEvents.size).toBe(0), { timeout: 500 })
    expect(firstAttempts).toBe(2)
    expect(secondAttempts).toBe(1)
  } finally { release(); inbox.close() }
})

it('retains failure backoff when no new readiness signal arrives', async () => {
  const record = { publicKey: 'owner', pendingDurableEvents: new Map([['pending', entry('pending')]]) }
  const inbox = new DurableSessionEvents(() => [record], async () => {})
  let attempts = 0
  inbox.onEvent([21113], async () => { attempts++; throw new Error('application still unavailable') })
  try {
    await vi.waitFor(() => expect(attempts).toBe(1))
    inbox.notifyReady()
    await vi.waitFor(() => expect(attempts).toBe(2))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(attempts).toBe(2)
    expect(record.pendingDurableEvents.size).toBe(1)
    inbox.close()
    inbox.notifyReady()
    expect(attempts).toBe(2)
  } finally { inbox.close() }
})
