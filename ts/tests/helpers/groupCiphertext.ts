import type { Rumor } from '../../src/types.js'

/** Capture a local intermediate envelope for sender-key cryptography tests.
 * These tests intentionally feed ciphertext directly, independent of the private transport.
 */
export async function captureGroupCiphertext(sender: any, method: 'sendMessage' | 'sendEvent', ...args: any[]): Promise<any> {
  const options = args.at(-1)
  const capture = options.publishOuter
  const result = await sender[method](...args.slice(0, -1), {
    ...options,
    sendPairwise: async (recipient: string, rumor: Rumor) => {
      if (rumor.kind !== 21113) return options.sendPairwise(recipient, rumor)
    },
    publishOuter: async () => { throw new Error('Shared group relay publication is forbidden') },
  })
  await capture(result.outer, result.inner.id)
  return result
}
