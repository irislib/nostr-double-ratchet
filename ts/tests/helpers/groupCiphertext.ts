export async function captureGroupCiphertext(sender: any, method: 'sendMessage' | 'sendEvent', ...args: any[]): Promise<any> {
  return sender[method](...args)
}
