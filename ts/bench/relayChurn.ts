import { ClientName, RelayStats, Participant, ScenarioMetrics, InstrumentedRelay, DeliveryMetrics, parsePayload, createParticipant, wait, withTimeout, initializeParticipants, buildPayload } from "./relayChurnSupport.js";

async function runDirectScenario(input: {
  runId: string;
  participants: Participant[];
  perDirection: number;
  timeoutMs: number;
  phase: "warmup" | "measure";
  metrics: DeliveryMetrics;
}): Promise<void> {
  const pending = new Map<
    string,
    {
      recipient: Participant;
      resolve: () => void;
    }
  >();

  const unsubscribes = input.participants.map((participant) =>
    participant.runtime.onSessionEvent((event, from) => {
      const payload = parsePayload(event.content);
      if (
        !payload ||
        payload.runId !== input.runId ||
        payload.scenario !== "direct" ||
        payload.phase !== input.phase
      ) {
        return;
      }

      const waiter = pending.get(payload.id);
      if (!waiter) {
        input.metrics.recordUnexpected();
        return;
      }

      if (
        participant.name !== waiter.recipient.name ||
        payload.to !== participant.name ||
        from !== input.participants.find((p) => p.name === payload.from)?.ownerPubkey
      ) {
        input.metrics.recordUnexpected();
        return;
      }

      input.metrics.recordDelivery(
        `${payload.id}:${participant.name}`,
        Date.now() - payload.sentAt,
      );
      pending.delete(payload.id);
      waiter.resolve();
    }),
  );

  try {
    const directedPairs = input.participants.flatMap((from) =>
      input.participants
        .filter((to) => to !== from)
        .map((to) => [from, to] as const),
    );
    let index = 0;
    for (let round = 0; round < input.perDirection; round += 1) {
      for (const [sender, recipient] of directedPairs) {
        const payload = buildPayload({
          runId: input.runId,
          scenario: "direct",
          phase: input.phase,
          from: sender.name,
          to: recipient.name,
          index,
        });
        index += 1;
        input.metrics.recordSend(1);
        const done = new Promise<void>((resolve) => {
          pending.set(payload.id, { recipient, resolve });
        });
        await sender.runtime.sendMessage(
          recipient.ownerPubkey,
          JSON.stringify(payload),
        );
        await withTimeout(
          done,
          input.timeoutMs,
          `direct delivery timed out for ${payload.id}`,
        ).catch((error) => {
          pending.delete(payload.id);
          input.metrics.recordTimeout(1);
          throw error;
        });
      }
    }
  } finally {
    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
  }
}

async function runGroupScenario(input: {
  runId: string;
  participants: Participant[];
  perSender: number;
  timeoutMs: number;
  phase: "warmup" | "measure";
  metrics: DeliveryMetrics;
}): Promise<void> {
  const [alice, bob, carol] = input.participants;
  if (!alice || !bob || !carol) {
    throw new Error("group scenario requires exactly three participants");
  }

  const created = await alice.runtime.createGroup(
    "NDR relay churn bench",
    [bob.ownerPubkey, carol.ownerPubkey],
    { fanoutMetadata: false },
  );
  for (const participant of input.participants) {
    await participant.runtime.syncGroups([created.group], participant.ownerPubkey);
  }

  const pending = new Map<
    string,
    {
      expectedRecipients: Set<ClientName>;
      resolve: () => void;
    }
  >();

  const unsubscribes = input.participants.map((participant) =>
    participant.runtime.onGroupEvent((event) => {
      const payload = parsePayload(event.inner.content);
      if (
        !payload ||
        payload.runId !== input.runId ||
        payload.scenario !== "group" ||
        payload.phase !== input.phase
      ) {
        return;
      }

      const waiter = pending.get(payload.id);
      if (!waiter) {
        input.metrics.recordUnexpected();
        return;
      }

      if (!waiter.expectedRecipients.has(participant.name)) {
        input.metrics.recordUnexpected();
        return;
      }

      input.metrics.recordDelivery(
        `${payload.id}:${participant.name}`,
        Date.now() - payload.sentAt,
      );
      waiter.expectedRecipients.delete(participant.name);
      if (waiter.expectedRecipients.size === 0) {
        pending.delete(payload.id);
        waiter.resolve();
      }
    }),
  );

  try {
    let index = 0;
    for (let round = 0; round < input.perSender; round += 1) {
      for (const sender of input.participants) {
        const payload = buildPayload({
          runId: input.runId,
          scenario: "group",
          phase: input.phase,
          from: sender.name,
          index,
        });
        index += 1;
        const expectedRecipients = new Set<ClientName>(
          input.participants
            .filter((participant) => participant !== sender)
            .map((participant) => participant.name),
        );
        input.metrics.recordSend(expectedRecipients.size);
        const done = new Promise<void>((resolve) => {
          pending.set(payload.id, {
            expectedRecipients,
            resolve,
          });
        });
        await sender.runtime.sendGroupMessage(
          created.group.id,
          JSON.stringify(payload),
        );
        await withTimeout(
          done,
          input.timeoutMs,
          `group delivery timed out for ${payload.id}`,
        ).catch((error) => {
          const waiter = pending.get(payload.id);
          pending.delete(payload.id);
          input.metrics.recordTimeout(waiter?.expectedRecipients.size || 0);
          throw error;
        });
      }
    }
  } finally {
    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
  }
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function printScenario(name: string, metrics: ScenarioMetrics): void {
  console.log(
    `${name}: sent=${metrics.sent} received=${metrics.receivedDeliveries}/${metrics.expectedDeliveries} ` +
      `timeouts=${metrics.timedOutDeliveries} dupDecoded=${metrics.duplicateDecodedDeliveries} ` +
      `unexpected=${metrics.unexpectedDeliveries} latencyMs p50=${metrics.latency.p50Ms} ` +
      `p95=${metrics.latency.p95Ms} max=${metrics.latency.maxMs}`,
  );
}

function printRelayStats(stats: RelayStats): void {
  console.log(
    `relay: req=${stats.subscribeCalls} close=${stats.unsubscribeCalls} ` +
      `publish=${stats.publishCalls} replayed=${stats.replayedEvents} ` +
      `delivered=${stats.deliveredEvents} active=${stats.activeSubscriptions} ` +
      `maxActive=${stats.maxActiveSubscriptions} approxBytes out=${stats.publishBytes} ` +
      `sub=${stats.subscriptionBytes} in=${stats.deliveredBytes}`,
  );
  for (const [client, clientStats] of Object.entries(stats.byClient)) {
    console.log(
      `  ${client}: req=${clientStats.subscribeCalls} close=${clientStats.unsubscribeCalls} ` +
        `publish=${clientStats.publishCalls} replayed=${clientStats.replayedEvents} ` +
        `delivered=${clientStats.deliveredEvents}`,
    );
  }
}

async function main(): Promise<void> {
  const directPerDirection = intFromEnv("NDR_BENCH_DIRECT_PER_DIRECTION", 3);
  const groupPerSender = intFromEnv("NDR_BENCH_GROUP_PER_SENDER", 3);
  const timeoutMs = intFromEnv("NDR_BENCH_TIMEOUT_MS", 10_000);
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const relay = new InstrumentedRelay();
  const participants: Participant[] = [
    createParticipant("alice", relay),
    createParticipant("bob", relay),
    createParticipant("carol", relay),
  ];

  console.log(
    `config: directPerDirection=${directPerDirection} groupPerSender=${groupPerSender} timeoutMs=${timeoutMs}`,
  );

  await initializeParticipants(participants);
  const warmupDirectMetrics = new DeliveryMetrics();
  await runDirectScenario({
    runId,
    participants,
    perDirection: 1,
    timeoutMs,
    phase: "warmup",
    metrics: warmupDirectMetrics,
  });

  await wait(1_700);
  relay.resetCounters();

  const directMetrics = new DeliveryMetrics();
  await runDirectScenario({
    runId,
    participants,
    perDirection: directPerDirection,
    timeoutMs,
    phase: "measure",
    metrics: directMetrics,
  });

  const groupMetrics = new DeliveryMetrics();
  await runGroupScenario({
    runId,
    participants,
    perSender: groupPerSender,
    timeoutMs,
    phase: "measure",
    metrics: groupMetrics,
  });

  await wait(1_700);
  const relayStats = relay.snapshot();
  const directSummary = directMetrics.summary();
  const groupSummary = groupMetrics.summary();
  const totalFailures =
    directSummary.timedOutDeliveries +
    directSummary.unexpectedDeliveries +
    groupSummary.timedOutDeliveries +
    groupSummary.unexpectedDeliveries;

  printScenario("direct", directSummary);
  printScenario("group", groupSummary);
  printRelayStats(relayStats);

  const result = {
    runId,
    config: {
      directPerDirection,
      groupPerSender,
      timeoutMs,
    },
    direct: directSummary,
    group: groupSummary,
    relay: relayStats,
    criticalFailures: totalFailures,
  };

  if (process.env.NDR_BENCH_JSON === "1") {
    console.log(JSON.stringify(result, null, 2));
  }

  if (totalFailures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
