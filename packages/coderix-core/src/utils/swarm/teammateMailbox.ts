/**
 * Teammate mailbox — file-based inter-agent message passing with structured
 * protocol support.
 *
 * Each teammate has an inbox file at:
 *   ~/.coderix/teams/{team_name}/inboxes/{agent_name}.json
 *
 * Uses proper-lockfile for concurrent access safety and supports 10 structured
 * protocol message types for permission delegation, shutdown coordination, plan
 * approval, and task assignment.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v4';
import lockfile from 'proper-lockfile';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAMS_DIR = join(homedir(), '.coderix', 'teams');

/** XML tag name for teammate messages in attachments. */
const TEAMMATE_MESSAGE_TAG = 'teammate-message';

/** Lock options: retry with backoff for concurrent swarm access. */
const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
};

export const MAX_MAILBOX_MESSAGES = 1_000;
export const MAX_READ_MAILBOX_MESSAGES = 200;
export const MAX_UNREAD_PROTOCOL_MAILBOX_MESSAGES = 2_000;
export const MAX_MAILBOX_MESSAGE_TEXT_BYTES = 64 * 1024;
export const MAX_MAILBOX_RETAINED_BYTES = 2 * 1024 * 1024;
export const MAX_MAILBOX_FILE_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Path sanitization
// ---------------------------------------------------------------------------

function sanitizePathComponent(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'unnamed';
}

/** Resolve team name from env or fallback. Lazy-loaded to avoid circular deps. */
function resolveTeamName(): string {
  return process.env.CODERIX_TEAM_NAME || 'default';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeammateMessage {
  from: string;
  text: string;
  timestamp: string;
  read: boolean;
  color?: string;
  summary?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getInboxPath(agentName: string, teamName?: string): string {
  const team = teamName || resolveTeamName();
  const safeTeam = sanitizePathComponent(team);
  const safeAgent = sanitizePathComponent(agentName);
  return join(TEAMS_DIR, safeTeam, 'inboxes', `${safeAgent}.json`);
}

function isJsonLikeMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function shouldRetainUnreadAsProtocolMessage(message: TeammateMessage): boolean {
  if (message.read) return false;
  if (isStructuredProtocolMessage(message.text)) return true;
  if (!isJsonLikeMessage(message.text)) return false;
  try {
    const parsed = JSON.parse(message.text);
    return Boolean(parsed && typeof parsed === 'object' && 'type' in (parsed as Record<string, unknown>));
  } catch {
    return false;
  }
}

function sameMailboxMessage(a: TeammateMessage, b: TeammateMessage): boolean {
  return a.from === b.from && a.timestamp === b.timestamp && a.text === b.text;
}

function mailboxMessageStorageBytes(message: TeammateMessage): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

function assertMailboxMessageSize(message: TeammateMessage): void {
  const textBytes = Buffer.byteLength(message.text, 'utf8');
  if (textBytes > MAX_MAILBOX_MESSAGE_TEXT_BYTES) {
    throw new Error(`Mailbox message text exceeds ${MAX_MAILBOX_MESSAGE_TEXT_BYTES} bytes`);
  }
}

function toMailboxMessage(value: unknown): TeammateMessage {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid mailbox message: expected object');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.from !== 'string' ||
    typeof record.text !== 'string' ||
    typeof record.timestamp !== 'string' ||
    typeof record.read !== 'boolean'
  ) {
    throw new Error('Invalid mailbox message shape');
  }
  const message: TeammateMessage = {
    from: record.from,
    text: record.text,
    timestamp: record.timestamp,
    read: record.read,
    ...(typeof record.color === 'string' ? { color: record.color } : {}),
    ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
  };
  assertMailboxMessageSize(message);
  return message;
}

function parseMailboxMessages(content: string): TeammateMessage[] {
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error('Invalid mailbox file: expected message array');
  }
  return parsed.map(toMailboxMessage);
}

async function readMailboxFile(inboxPath: string): Promise<string> {
  const info = await stat(inboxPath);
  if (info.size > MAX_MAILBOX_FILE_BYTES) {
    throw new Error(`Mailbox file exceeds ${MAX_MAILBOX_FILE_BYTES} bytes: ${inboxPath}`);
  }
  return readFile(inboxPath, 'utf-8');
}

async function readMailboxForMutation(
  agentName: string,
  teamName?: string,
): Promise<TeammateMessage[]> {
  const path = getInboxPath(agentName, teamName);
  return parseMailboxMessages(await readMailboxFile(path));
}

async function writeMailboxAtomic(inboxPath: string, content: string): Promise<void> {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_MAILBOX_FILE_BYTES) {
    throw new Error(`Compacted mailbox still exceeds ${MAX_MAILBOX_FILE_BYTES} bytes`);
  }
  const tmpPath = `${inboxPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(tmpPath, content, 'utf-8');
    await rename(tmpPath, inboxPath);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

function getErrnoCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    return (error as { code: string }).code;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

export function compactMailboxMessages(
  messages: TeammateMessage[],
  limits: {
    maxMessages?: number;
    maxReadMessages?: number;
    maxUnreadProtocolMessages?: number;
    maxRetainedBytes?: number;
  } = {},
): TeammateMessage[] {
  const maxMessages = limits.maxMessages ?? MAX_MAILBOX_MESSAGES;
  const maxReadMessages = limits.maxReadMessages ?? MAX_READ_MAILBOX_MESSAGES;
  const maxUnreadProtocolMessages =
    limits.maxUnreadProtocolMessages ?? MAX_UNREAD_PROTOCOL_MAILBOX_MESSAGES;
  const maxRetainedBytes = limits.maxRetainedBytes ?? MAX_MAILBOX_RETAINED_BYTES;

  if (maxRetainedBytes <= 0 || (maxMessages <= 0 && maxUnreadProtocolMessages <= 0)) {
    return [];
  }

  const keepIndexes = new Set<number>();
  let retainedBytes = 0;
  let keptUnreadProtocolMessages = 0;

  const tryKeep = (index: number): boolean => {
    if (keepIndexes.has(index)) return true;
    const message = messages[index];
    if (!message) return false;
    const bytes = mailboxMessageStorageBytes(message);
    if (bytes > maxRetainedBytes || retainedBytes + bytes > maxRetainedBytes) return false;
    keepIndexes.add(index);
    retainedBytes += bytes;
    return true;
  };

  // Phase 1: Keep unread protocol messages (newest first)
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || !shouldRetainUnreadAsProtocolMessage(message)) continue;
    if (keptUnreadProtocolMessages >= maxUnreadProtocolMessages) continue;
    if (tryKeep(i)) keptUnreadProtocolMessages++;
  }

  // Phase 2: Keep unread non-protocol messages (newest first)
  let keptNonProtocolMessages = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (keptNonProtocolMessages >= maxMessages) break;
    const message = messages[i];
    if (message && !message.read && !shouldRetainUnreadAsProtocolMessage(message)) {
      if (tryKeep(i)) keptNonProtocolMessages++;
    }
  }

  // Phase 3: Keep read messages (newest first, up to maxReadMessages)
  let keptReadMessages = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (keptNonProtocolMessages >= maxMessages) break;
    if (keptReadMessages >= maxReadMessages) break;
    const message = messages[i];
    if (message?.read) {
      if (tryKeep(i)) {
        keptReadMessages++;
        keptNonProtocolMessages++;
      }
    }
  }

  return messages.filter((_message, index) => keepIndexes.has(index));
}

async function writeCompactedMailbox(
  inboxPath: string,
  messages: TeammateMessage[],
): Promise<void> {
  const compacted = compactMailboxMessages(messages);
  await writeMailboxAtomic(inboxPath, JSON.stringify(compacted, null, 2));
}

// ---------------------------------------------------------------------------
// Lock helpers
// ---------------------------------------------------------------------------

async function ensureInboxDir(teamName?: string): Promise<void> {
  const team = teamName || resolveTeamName();
  const safeTeam = sanitizePathComponent(team);
  const inboxDir = join(TEAMS_DIR, safeTeam, 'inboxes');
  await mkdir(inboxDir, { recursive: true });
}

async function ensureLockFile(lockPath: string): Promise<void> {
  try {
    await writeFile(lockPath, '', { flag: 'wx' });
  } catch {
    // File already exists — fine
  }
}

// ---------------------------------------------------------------------------
// Public API — Basic I/O
// ---------------------------------------------------------------------------

/** Read all messages from a teammate's inbox. */
export async function readMailbox(
  agentName: string,
  teamName?: string,
): Promise<TeammateMessage[]> {
  const path = getInboxPath(agentName, teamName);
  try {
    return parseMailboxMessages(await readMailboxFile(path));
  } catch (error) {
    const code = getErrnoCode(error);
    if (code === 'ENOENT') return [];
    throw error;
  }
}

/** Read only unread messages from a teammate's inbox. */
export async function readUnreadMessages(
  agentName: string,
  teamName?: string,
): Promise<TeammateMessage[]> {
  const messages = await readMailbox(agentName, teamName);
  return messages.filter(m => !m.read);
}

/**
 * Write a message to a teammate's inbox.
 * Uses file locking to prevent race conditions during concurrent access.
 */
export async function writeToMailbox(
  recipientName: string,
  message: Omit<TeammateMessage, 'read'>,
  teamName?: string,
): Promise<void> {
  await ensureInboxDir(teamName);

  const inboxPath = getInboxPath(recipientName, teamName);
  const lockFilePath = `${inboxPath}.lock`;

  // Ensure the inbox file exists before locking
  try {
    await writeFile(inboxPath, '[]', { encoding: 'utf-8', flag: 'wx' });
  } catch (error) {
    const code = getErrnoCode(error);
    if (code !== 'EEXIST') throw error;
  }

  await ensureLockFile(lockFilePath);
  const release = await lockfile.lock(lockFilePath, LOCK_OPTIONS);
  try {
    const messages = await readMailboxForMutation(recipientName, teamName);
    const newMessage = toMailboxMessage({ ...message, read: false });
    messages.push(newMessage);
    await writeCompactedMailbox(inboxPath, messages);
  } finally {
    await release();
  }
}

/** Mark a specific message as read by index. Uses file locking. */
export async function markMessageAsReadByIndex(
  agentName: string,
  teamName: string | undefined,
  messageIndex: number,
): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName);
  const lockFilePath = `${inboxPath}.lock`;

  await ensureLockFile(lockFilePath);
  const release = await lockfile.lock(lockFilePath, LOCK_OPTIONS);
  try {
    const messages = await readMailboxForMutation(agentName, teamName);
    if (messageIndex < 0 || messageIndex >= messages.length) return;
    const message = messages[messageIndex];
    if (!message || message.read) return;
    messages[messageIndex] = { ...message, read: true };
    await writeCompactedMailbox(inboxPath, messages);
  } catch (error) {
    const code = getErrnoCode(error);
    if (code !== 'ENOENT') throw error;
  } finally {
    await release();
  }
}

/**
 * Mark a message as read by matching its identity (from + timestamp + text).
 * Returns true if a matching unread message was found and marked.
 */
export async function markMessageAsReadByIdentity(
  agentName: string,
  teamName: string | undefined,
  expectedMessage: TeammateMessage,
): Promise<boolean> {
  const inboxPath = getInboxPath(agentName, teamName);
  const lockFilePath = `${inboxPath}.lock`;

  await ensureLockFile(lockFilePath);
  const release = await lockfile.lock(lockFilePath, LOCK_OPTIONS);
  try {
    const messages = await readMailboxForMutation(agentName, teamName);
    const messageIndex = messages.findIndex(
      m => !m.read && sameMailboxMessage(m, expectedMessage),
    );
    if (messageIndex < 0) return false;
    messages[messageIndex] = { ...messages[messageIndex]!, read: true };
    await writeCompactedMailbox(inboxPath, messages);
    return true;
  } catch (error) {
    const code = getErrnoCode(error);
    if (code === 'ENOENT') return false;
    throw error;
  } finally {
    await release();
  }
}

/** Mark all messages in a teammate's inbox as read. */
export async function markMessagesAsRead(
  agentName: string,
  teamName?: string,
): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName);
  const lockFilePath = `${inboxPath}.lock`;

  await ensureLockFile(lockFilePath);
  const release = await lockfile.lock(lockFilePath, LOCK_OPTIONS);
  try {
    const messages = await readMailboxForMutation(agentName, teamName);
    if (messages.length === 0) return;
    for (const m of messages) m.read = true;
    await writeCompactedMailbox(inboxPath, messages);
  } catch (error) {
    const code = getErrnoCode(error);
    if (code !== 'ENOENT') throw error;
  } finally {
    await release();
  }
}

/**
 * Mark only messages matching a predicate as read, leaving others unread.
 * Uses the same file-locking mechanism.
 */
export async function markMessagesAsReadByPredicate(
  agentName: string,
  predicate: (msg: TeammateMessage) => boolean,
  teamName?: string,
): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName);
  const lockFilePath = `${inboxPath}.lock`;

  await ensureLockFile(lockFilePath);
  const release = await lockfile.lock(lockFilePath, LOCK_OPTIONS);
  try {
    const messages = await readMailboxForMutation(agentName, teamName);
    if (messages.length === 0) return;
    const updated = messages.map(m => (!m.read && predicate(m) ? { ...m, read: true } : m));
    await writeCompactedMailbox(inboxPath, updated);
  } catch (error) {
    const code = getErrnoCode(error);
    if (code !== 'ENOENT') throw error;
  } finally {
    await release().catch(() => {});
  }
}

/** Clear a teammate's inbox (truncate to empty). */
export async function clearMailbox(
  agentName: string,
  teamName?: string,
): Promise<void> {
  const inboxPath = getInboxPath(agentName, teamName);
  try {
    // Use 'r+' so we throw ENOENT if the file doesn't exist
    await writeFile(inboxPath, '[]', { encoding: 'utf-8', flag: 'r+' });
  } catch (error) {
    const code = getErrnoCode(error);
    if (code === 'ENOENT') return;
    throw error;
  }
}

/** Delete all inboxes for a team. */
export async function deleteTeamMailboxes(teamName: string): Promise<void> {
  const safeTeam = sanitizePathComponent(teamName);
  const inboxesDir = join(TEAMS_DIR, safeTeam, 'inboxes');
  try {
    const { rm } = await import('node:fs/promises');
    await rm(inboxesDir, { recursive: true, force: true });
  } catch {
    // Already gone
  }
}

// ---------------------------------------------------------------------------
// XML formatting
// ---------------------------------------------------------------------------

/** Format teammate messages as XML for attachment display. */
export function formatTeammateMessages(
  messages: Array<{
    from: string;
    text: string;
    timestamp: string;
    color?: string;
    summary?: string;
  }>,
): string {
  return messages
    .map(m => {
      const colorAttr = m.color ? ` color="${m.color}"` : '';
      const summaryAttr = m.summary ? ` summary="${m.summary}"` : '';
      return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${colorAttr}${summaryAttr}>\n${m.text}\n</${TEAMMATE_MESSAGE_TAG}>`;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Idle notification
// ---------------------------------------------------------------------------

export interface IdleNotificationMessage {
  type: 'idle_notification';
  from: string;
  timestamp: string;
  idleReason?: 'available' | 'interrupted' | 'failed';
  summary?: string;
  completedTaskId?: string;
  completedStatus?: 'resolved' | 'blocked' | 'failed';
  failureReason?: string;
}

export function createIdleNotification(
  agentId: string,
  options?: {
    idleReason?: IdleNotificationMessage['idleReason'];
    summary?: string;
    completedTaskId?: string;
    completedStatus?: 'resolved' | 'blocked' | 'failed';
    failureReason?: string;
  },
): IdleNotificationMessage {
  return {
    type: 'idle_notification',
    from: agentId,
    timestamp: new Date().toISOString(),
    idleReason: options?.idleReason,
    summary: options?.summary,
    completedTaskId: options?.completedTaskId,
    completedStatus: options?.completedStatus,
    failureReason: options?.failureReason,
  };
}

export function isIdleNotification(messageText: string): IdleNotificationMessage | null {
  try {
    const parsed = JSON.parse(messageText);
    if (parsed && parsed.type === 'idle_notification') return parsed as IdleNotificationMessage;
  } catch { /* not JSON */ }
  return null;
}

// ---------------------------------------------------------------------------
// Permission request / response
// ---------------------------------------------------------------------------

export interface PermissionRequestMessage {
  type: 'permission_request';
  request_id: string;
  agent_id: string;
  tool_name: string;
  tool_use_id: string;
  description: string;
  input: Record<string, unknown>;
  permission_suggestions: unknown[];
}

export type PermissionResponseMessage =
  | {
      type: 'permission_response';
      request_id: string;
      subtype: 'success';
      response?: {
        updated_input?: Record<string, unknown>;
        permission_updates?: unknown[];
      };
    }
  | {
      type: 'permission_response';
      request_id: string;
      subtype: 'error';
      error: string;
    };

export function createPermissionRequestMessage(params: {
  request_id: string;
  agent_id: string;
  tool_name: string;
  tool_use_id: string;
  description: string;
  input: Record<string, unknown>;
  permission_suggestions?: unknown[];
}): PermissionRequestMessage {
  return {
    type: 'permission_request',
    request_id: params.request_id,
    agent_id: params.agent_id,
    tool_name: params.tool_name,
    tool_use_id: params.tool_use_id,
    description: params.description,
    input: params.input,
    permission_suggestions: params.permission_suggestions || [],
  };
}

export function createPermissionResponseMessage(params: {
  request_id: string;
  subtype: 'success' | 'error';
  error?: string;
  updated_input?: Record<string, unknown>;
  permission_updates?: unknown[];
}): PermissionResponseMessage {
  if (params.subtype === 'error') {
    return {
      type: 'permission_response',
      request_id: params.request_id,
      subtype: 'error',
      error: params.error || 'Permission denied',
    };
  }
  return {
    type: 'permission_response',
    request_id: params.request_id,
    subtype: 'success',
    response: {
      updated_input: params.updated_input,
      permission_updates: params.permission_updates,
    },
  };
}

export function isPermissionRequest(messageText: string): PermissionRequestMessage | null {
  try {
    const parsed = JSON.parse(messageText);
    if (parsed && parsed.type === 'permission_request') return parsed as PermissionRequestMessage;
  } catch { /* not JSON */ }
  return null;
}

export function isPermissionResponse(messageText: string): PermissionResponseMessage | null {
  try {
    const parsed = JSON.parse(messageText);
    if (parsed && parsed.type === 'permission_response') return parsed as PermissionResponseMessage;
  } catch { /* not JSON */ }
  return null;
}

// ---------------------------------------------------------------------------
// Sandbox permission
// ---------------------------------------------------------------------------

export interface SandboxPermissionRequestMessage {
  type: 'sandbox_permission_request';
  requestId: string;
  workerId: string;
  workerName: string;
  workerColor?: string;
  hostPattern: { host: string };
  createdAt: number;
}

export interface SandboxPermissionResponseMessage {
  type: 'sandbox_permission_response';
  requestId: string;
  host: string;
  allow: boolean;
  timestamp: string;
}

export function createSandboxPermissionRequestMessage(params: {
  requestId: string;
  workerId: string;
  workerName: string;
  workerColor?: string;
  host: string;
}): SandboxPermissionRequestMessage {
  return {
    type: 'sandbox_permission_request',
    requestId: params.requestId,
    workerId: params.workerId,
    workerName: params.workerName,
    workerColor: params.workerColor,
    hostPattern: { host: params.host },
    createdAt: Date.now(),
  };
}

export function createSandboxPermissionResponseMessage(params: {
  requestId: string;
  host: string;
  allow: boolean;
}): SandboxPermissionResponseMessage {
  return {
    type: 'sandbox_permission_response',
    requestId: params.requestId,
    host: params.host,
    allow: params.allow,
    timestamp: new Date().toISOString(),
  };
}

export function isSandboxPermissionRequest(messageText: string): SandboxPermissionRequestMessage | null {
  try {
    const parsed = JSON.parse(messageText);
    if (parsed && parsed.type === 'sandbox_permission_request') return parsed as SandboxPermissionRequestMessage;
  } catch { /* not JSON */ }
  return null;
}

export function isSandboxPermissionResponse(messageText: string): SandboxPermissionResponseMessage | null {
  try {
    const parsed = JSON.parse(messageText);
    if (parsed && parsed.type === 'sandbox_permission_response') return parsed as SandboxPermissionResponseMessage;
  } catch { /* not JSON */ }
  return null;
}

// ---------------------------------------------------------------------------
// Plan approval
// ---------------------------------------------------------------------------

export const PlanApprovalRequestMessageSchema = z.object({
  type: z.literal('plan_approval_request'),
  from: z.string(),
  timestamp: z.string(),
  planFilePath: z.string(),
  planContent: z.string(),
  requestId: z.string(),
});

export type PlanApprovalRequestMessage = z.infer<typeof PlanApprovalRequestMessageSchema>;

export const PlanApprovalResponseMessageSchema = z.object({
  type: z.literal('plan_approval_response'),
  requestId: z.string(),
  approved: z.boolean(),
  feedback: z.string().optional(),
  timestamp: z.string(),
});

export type PlanApprovalResponseMessage = z.infer<typeof PlanApprovalResponseMessageSchema>;

export function isPlanApprovalRequest(messageText: string): PlanApprovalRequestMessage | null {
  try {
    const result = PlanApprovalRequestMessageSchema.safeParse(JSON.parse(messageText));
    if (result.success) return result.data;
  } catch { /* not JSON */ }
  return null;
}

export function isPlanApprovalResponse(messageText: string): PlanApprovalResponseMessage | null {
  try {
    const result = PlanApprovalResponseMessageSchema.safeParse(JSON.parse(messageText));
    if (result.success) return result.data;
  } catch { /* not JSON */ }
  return null;
}

// ---------------------------------------------------------------------------
// Shutdown protocol
// ---------------------------------------------------------------------------

export const ShutdownRequestMessageSchema = z.object({
  type: z.literal('shutdown_request'),
  requestId: z.string(),
  from: z.string(),
  reason: z.string().optional(),
  timestamp: z.string(),
});

export type ShutdownRequestMessage = z.infer<typeof ShutdownRequestMessageSchema>;

export const ShutdownApprovedMessageSchema = z.object({
  type: z.literal('shutdown_approved'),
  requestId: z.string(),
  from: z.string(),
  timestamp: z.string(),
});

export type ShutdownApprovedMessage = z.infer<typeof ShutdownApprovedMessageSchema>;

export const ShutdownRejectedMessageSchema = z.object({
  type: z.literal('shutdown_rejected'),
  requestId: z.string(),
  from: z.string(),
  reason: z.string(),
  timestamp: z.string(),
});

export type ShutdownRejectedMessage = z.infer<typeof ShutdownRejectedMessageSchema>;

export function createShutdownRequestMessage(params: {
  requestId: string;
  from: string;
  reason?: string;
}): ShutdownRequestMessage {
  return {
    type: 'shutdown_request',
    requestId: params.requestId,
    from: params.from,
    reason: params.reason,
    timestamp: new Date().toISOString(),
  };
}

export function createShutdownApprovedMessage(params: {
  requestId: string;
  from: string;
}): ShutdownApprovedMessage {
  return {
    type: 'shutdown_approved',
    requestId: params.requestId,
    from: params.from,
    timestamp: new Date().toISOString(),
  };
}

export function createShutdownRejectedMessage(params: {
  requestId: string;
  from: string;
  reason: string;
}): ShutdownRejectedMessage {
  return {
    type: 'shutdown_rejected',
    requestId: params.requestId,
    from: params.from,
    reason: params.reason,
    timestamp: new Date().toISOString(),
  };
}

export async function sendShutdownRequestToMailbox(
  targetName: string,
  teamName?: string,
  reason?: string,
): Promise<{ requestId: string; target: string }> {
  const resolvedTeamName = teamName || resolveTeamName();
  const senderName = process.env.CODERIX_AGENT_NAME || 'leader';
  const requestId = `shutdown-${targetName}-${Date.now()}`;

  const shutdownMessage = createShutdownRequestMessage({
    requestId,
    from: senderName,
    reason,
  });

  await writeToMailbox(
    targetName,
    {
      from: senderName,
      text: JSON.stringify(shutdownMessage),
      timestamp: new Date().toISOString(),
    },
    resolvedTeamName,
  );

  return { requestId, target: targetName };
}

export function isShutdownRequest(messageText: string): ShutdownRequestMessage | null {
  try {
    const result = ShutdownRequestMessageSchema.safeParse(JSON.parse(messageText));
    if (result.success) return result.data;
  } catch { /* not JSON */ }
  return null;
}

export function isShutdownApproved(messageText: string): ShutdownApprovedMessage | null {
  try {
    const result = ShutdownApprovedMessageSchema.safeParse(JSON.parse(messageText));
    if (result.success) return result.data;
  } catch { /* not JSON */ }
  return null;
}

export function isShutdownRejected(messageText: string): ShutdownRejectedMessage | null {
  try {
    const result = ShutdownRejectedMessageSchema.safeParse(JSON.parse(messageText));
    if (result.success) return result.data;
  } catch { /* not JSON */ }
  return null;
}

// ---------------------------------------------------------------------------
// Task assignment
// ---------------------------------------------------------------------------

export interface TaskAssignmentMessage {
  type: 'task_assignment';
  taskId: string;
  subject: string;
  description: string;
  assignedBy: string;
  timestamp: string;
}

export function isTaskAssignment(messageText: string): TaskAssignmentMessage | null {
  try {
    const parsed = JSON.parse(messageText);
    if (parsed && parsed.type === 'task_assignment') return parsed as TaskAssignmentMessage;
  } catch { /* not JSON */ }
  return null;
}

// ---------------------------------------------------------------------------
// Team permission update
// ---------------------------------------------------------------------------

export interface TeamPermissionUpdateMessage {
  type: 'team_permission_update';
  permissionUpdate: {
    type: 'addRules';
    rules: Array<{ toolName: string; ruleContent?: string }>;
    behavior: 'allow' | 'deny' | 'ask';
    destination: 'session';
  };
  directoryPath: string;
  toolName: string;
}

export function isTeamPermissionUpdate(messageText: string): TeamPermissionUpdateMessage | null {
  try {
    const parsed = JSON.parse(messageText);
    if (parsed && parsed.type === 'team_permission_update') return parsed as TeamPermissionUpdateMessage;
  } catch { /* not JSON */ }
  return null;
}

// ---------------------------------------------------------------------------
// Mode set request
// ---------------------------------------------------------------------------

export const ModeSetRequestMessageSchema = z.object({
  type: z.literal('mode_set_request'),
  mode: z.string(),
  from: z.string(),
});

export type ModeSetRequestMessage = z.infer<typeof ModeSetRequestMessageSchema>;

export function createModeSetRequestMessage(params: {
  mode: string;
  from: string;
}): ModeSetRequestMessage {
  return {
    type: 'mode_set_request',
    mode: params.mode,
    from: params.from,
  };
}

export function isModeSetRequest(messageText: string): ModeSetRequestMessage | null {
  try {
    const result = ModeSetRequestMessageSchema.safeParse(JSON.parse(messageText));
    if (result.success) return result.data;
  } catch { /* not JSON */ }
  return null;
}

// ---------------------------------------------------------------------------
// Protocol message routing
// ---------------------------------------------------------------------------

/**
 * Checks if a message text is a structured protocol message that should be
 * routed by the inbox poller rather than consumed as raw LLM context.
 */
export function isStructuredProtocolMessage(messageText: string): boolean {
  try {
    const parsed = JSON.parse(messageText);
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return false;
    const type = (parsed as { type: unknown }).type;
    return (
      type === 'permission_request' ||
      type === 'permission_response' ||
      type === 'sandbox_permission_request' ||
      type === 'sandbox_permission_response' ||
      type === 'shutdown_request' ||
      type === 'shutdown_approved' ||
      type === 'team_permission_update' ||
      type === 'mode_set_request' ||
      type === 'plan_approval_request' ||
      type === 'plan_approval_response'
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Last peer DM summary
// ---------------------------------------------------------------------------

/**
 * Extracts a "[to {name}] {summary}" string from the last assistant message
 * if it ended with a SendMessage tool_use targeting a peer (not the team lead).
 */
export function getLastPeerDmSummary(
  messages: Array<{ type: string; message?: { content: unknown } }>,
): string | undefined {
  const SEND_MESSAGE_TOOL_NAME = 'SendMessage';
  const TEAM_LEAD_NAME = 'leader';

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.type === 'user' && typeof (msg.message?.content) === 'string') break;
    if (msg.type !== 'assistant') continue;

    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block === 'string') continue;
      const b = block as unknown as {
        type: string; name?: string; input?: Record<string, unknown>;
      };
      if (
        b.type === 'tool_use' &&
        b.name === SEND_MESSAGE_TOOL_NAME &&
        typeof b.input === 'object' &&
        b.input !== null &&
        'to' in b.input &&
        typeof b.input.to === 'string' &&
        b.input.to !== '*' &&
        b.input.to.toLowerCase() !== TEAM_LEAD_NAME.toLowerCase() &&
        'message' in b.input &&
        typeof b.input.message === 'string'
      ) {
        const to = b.input.to as string;
        const summary =
          'summary' in b.input && typeof b.input.summary === 'string'
            ? (b.input.summary as string)
            : (b.input.message as string).slice(0, 80);
        return `[to ${to}] ${summary}`;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Permission response polling (worker-side)
// ---------------------------------------------------------------------------

/**
 * Poll the worker's mailbox for a permission response from the leader.
 * Returns the response when it arrives, or rejects if aborted.
 */
export async function waitForPermissionResponse(
  agentName: string,
  requestId: string,
  teamName: string,
  abortController: AbortController,
  pollIntervalMs = 500,
): Promise<{ approved: boolean; feedback?: string }> {
  const POLL_INTERVAL = pollIntervalMs;
  const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minute timeout
  const startTime = Date.now();

  while (!abortController.signal.aborted) {
    if (Date.now() - startTime > MAX_WAIT_MS) {
      throw new Error('Permission request timed out waiting for leader response');
    }

    const unread = await readUnreadMessages(agentName, teamName);
    for (const msg of unread) {
      const response = isPermissionResponse(msg.text);
      if (response && response.request_id === requestId) {
        await markMessagesAsRead(agentName, teamName);
        return {
          approved: response.subtype === 'success',
          feedback: response.subtype === 'error' ? response.error : undefined,
        };
      }
    }

    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, POLL_INTERVAL);
      const onAbort = () => {
        clearTimeout(timeout);
        resolve();
      };
      abortController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  throw new Error('Aborted while waiting for permission response');
}
