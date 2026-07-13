import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { URL } from 'node:url';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import {
  ConversationStateSchema,
  DecisionRequestSchema,
  SendTurnRequestSchema,
  StartChatRequestSchema,
  StartChatResponseSchema,
  type ConversationState,
} from '@agentops/contracts';
import { platformChat } from '@agentops/workflows';
import type { ControlDeps } from './create-control-server';
import { listRunsByType, readJsonBody, type HandlerResponse } from './handler-util';

export async function handleStartChat(deps: ControlDeps, req: IncomingMessage): Promise<HandlerResponse> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  const parsed = StartChatRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues.map((i) => i.message).join('; ') } };
  }
  const { prompt, hintRepos } = parsed.data;
  const chatId = `platform-chat-${randomUUID()}`;
  try {
    const handle = await deps.client.workflow.start(platformChat, {
      taskQueue: deps.taskQueue,
      workflowId: chatId,
      args: [{ prompt, hintRepos }],
      memo: { prompt: prompt ?? '' },
    });
    return {
      status: 202,
      body: StartChatResponseSchema.parse({ chatId: handle.workflowId, runId: handle.firstExecutionRunId }),
    };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      return { status: 409, body: { error: `a chat with id "${chatId}" already exists` } };
    }
    throw err;
  }
}

export async function handleListChats(deps: ControlDeps, url: URL): Promise<HandlerResponse> {
  return listRunsByType(deps, url, 'platformChat');
}

export async function handleGetChat(deps: ControlDeps, chatId: string): Promise<HandlerResponse> {
  const handle = deps.client.workflow.getHandle<typeof platformChat>(chatId);
  let description;
  try {
    description = await handle.describe();
  } catch {
    return { status: 404, body: { error: `no chat found with id "${chatId}"` } };
  }
  if (description.status.name === 'RUNNING') {
    try {
      const state = ConversationStateSchema.parse(await handle.query('conversation'));
      return { status: 200, body: state };
    } catch {
      // Closed between describe() and query(), or an unexpected shape -- fall through.
    }
  }
  // Closed (or transiently unqueryable): report a closed state. The UI keeps its
  // last-polled transcript and just stops polling (design §7).
  const closed: ConversationState = { chatId, phase: 'closed', messages: [] };
  return { status: 200, body: closed };
}

export async function handleSendTurn(deps: ControlDeps, chatId: string, req: IncomingMessage): Promise<HandlerResponse> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  const parsed = SendTurnRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues.map((i) => i.message).join('; ') } };
  }
  const handle = deps.client.workflow.getHandle<typeof platformChat>(chatId);
  await handle.signal('userTurn', parsed.data.text);
  return { status: 202 };
}

export async function handleDecision(deps: ControlDeps, chatId: string, req: IncomingMessage): Promise<HandlerResponse> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  const parsed = DecisionRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues.map((i) => i.message).join('; ') } };
  }
  const handle = deps.client.workflow.getHandle<typeof platformChat>(chatId);
  await handle.signal('decision', parsed.data);
  return { status: 202 };
}

export async function handleCloseChat(deps: ControlDeps, chatId: string): Promise<HandlerResponse> {
  const handle = deps.client.workflow.getHandle<typeof platformChat>(chatId);
  await handle.signal('close');
  return { status: 202 };
}