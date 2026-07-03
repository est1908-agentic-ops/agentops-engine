import { Client, Connection } from '@temporalio/client';
import type { TaskInput } from '@agentops/contracts';
import { cancelSignal, clarifySignal, devCycle, resumeSignal, stateQuery, stopSignal } from '@agentops/workflows';

const TASK_QUEUE = 'agentops-devcycle';

function defaultConfig(): TaskInput['config'] {
  return {
    fastVerifyCommands: ['pnpm lint'],
    fullVerifyCommands: ['pnpm test'],
    stages: {},
    routing: {},
    brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
  };
}

async function getClient(): Promise<Client> {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  return new Client({ connection });
}

async function cmdStart(taskId: string, goal: string, product: string, repo: string, issueRef?: string): Promise<void> {
  const client = await getClient();
  const input: TaskInput = { taskId, product, repo, issueRef, goal, config: defaultConfig() };
  const handle = await client.workflow.start(devCycle, { taskQueue: TASK_QUEUE, workflowId: taskId, args: [input] });
  console.log(`started ${handle.workflowId}`);
}

async function cmdSignal(taskId: string, signal: string, text?: string): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle(taskId);
  if (signal === 'stop') {
    await handle.signal(stopSignal);
  } else if (signal === 'cancel') {
    await handle.signal(cancelSignal);
  } else if (signal === 'resume') {
    await handle.signal(resumeSignal);
  } else if (signal === 'clarify') {
    await handle.signal(clarifySignal, text ?? '');
  } else {
    throw new Error(`unknown signal: ${signal} (expected stop|cancel|resume|clarify)`);
  }
  console.log(`sent ${signal} to ${taskId}`);
}

async function cmdState(taskId: string): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle(taskId);
  const state = await handle.query(stateQuery);
  console.log(JSON.stringify(state, null, 2));
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (command === 'start') {
    const [taskId, goal, product = 'default', repo = 'default', issueRef] = rest;
    if (!taskId || !goal) {
      throw new Error('usage: cli start <taskId> <goal> [product] [repo] [issueRef]');
    }
    await cmdStart(taskId, goal, product, repo, issueRef);
  } else if (command === 'signal') {
    const [taskId, signal, text] = rest;
    if (!taskId || !signal) {
      throw new Error('usage: cli signal <taskId> <stop|cancel|resume|clarify> [text]');
    }
    await cmdSignal(taskId, signal, text);
  } else if (command === 'state') {
    const [taskId] = rest;
    if (!taskId) {
      throw new Error('usage: cli state <taskId>');
    }
    await cmdState(taskId);
  } else {
    console.error('usage: cli <start|signal|state> ...');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
