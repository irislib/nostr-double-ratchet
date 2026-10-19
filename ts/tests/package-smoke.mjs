// Run from a disposable consumer directory after installing the npm tarball.
// Regression for #26: public SessionManager sends must contain transport failures.
import assert from "node:assert/strict";
import { NdrRuntime, InMemoryStorageAdapter } from "nostr-double-ratchet";
import { finalizeEvent, getPublicKey, matchFilter } from "nostr-tools";

const keys = [1, 2].map((scalar) => {
  const key = new Uint8Array(32);
  key[31] = scalar;
  return key;
});
const owners = keys.map(getPublicKey);
const events = [];
const listeners = new Set();
const failures = [];
const unhandled = [];
let rejectMessages = false;
let attempts = 0;
const onUnhandled = (error) => unhandled.push(error);
const fetchEvents = (filter) => {
  const selected = new Map();
  for (const event of events) {
    if (!matchFilter(filter, event)) continue;
    const replaceable = event.kind === 0 || event.kind === 3 ||
      (event.kind >= 10000 && event.kind < 40000);
    const id = replaceable
      ? `${event.kind}:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1] ?? ""}`
      : event.id;
    selected.set(id, event);
  }
  return [...selected.values()];
};
process.on("unhandledRejection", onUnhandled);
const runtimes = keys.map((key, index) => new NdrRuntime({
  storage: new InMemoryStorageAdapter(),
  appKeysFastTimeoutMs: 25,
  appKeysFetchTimeoutMs: 75,
  nostrFetch: async (filter) => fetchEvents(filter),
  nostrSubscribe(filter, onEvent) {
    const listener = { filter, onEvent };
    listeners.add(listener);
    for (const event of fetchEvents(filter)) onEvent(event);
    return () => listeners.delete(listener);
  },
  async nostrPublish(input, innerEventId) {
    if (index === 0 && rejectMessages && input.kind === 1060 && innerEventId) {
      attempts += 1;
      throw new Error("test-publisher-rejected");
    }
    const event = input.sig ? input : finalizeEvent(input, key);
    events.push(event);
    for (const listener of [...listeners]) {
      if (matchFilter(listener.filter, event)) listener.onEvent(event);
    }
    return event;
  },
  onPublishError: (failure) => failures.push(failure),
}));
try {
  for (let index = 0; index < runtimes.length; index += 1) {
    await runtimes[index].initForOwner(owners[index]);
    await runtimes[index].registerCurrentDevice({ ownerPubkey: owners[index], timeoutMs: 250 });
    await runtimes[index].republishInvite();
  }
  await runtimes[0].setupUser(owners[1], owners[0]);
  const manager = await runtimes[0].waitForSessionManager(owners[0]);
  rejectMessages = true;
  const rumor = await manager.sendMessage(owners[1], "");
  const deadline = Date.now() + 4000;
  while (attempts === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Let promise-rejection notifications run after the publisher settles.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(rumor.id, /^[a-f0-9]{64}$/);
  assert.ok(attempts > 0, "encrypted publication was not attempted");
  assert.equal(unhandled.length, 0, "publisher rejection escaped the runtime");
  assert.ok(failures.some((failure) =>
    failure.innerEventId === rumor.id && failure.error?.message === "test-publisher-rejected"
  ), "onPublishError did not report the failed message");
  console.log(JSON.stringify({
    returnedRumor: true, publisherAttempts: attempts,
    reportedFailures: failures.length, unhandledRejections: unhandled.length,
  }));
} finally {
  for (const runtime of runtimes) runtime.close();
  process.removeListener("unhandledRejection", onUnhandled);
}
