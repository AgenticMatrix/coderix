/**
 * Swarm constants — shared identifiers for team and swarm operations.
 */

/** Reserved name for the team leader. */
export const TEAM_LEAD_NAME = 'leader';

/** Default polling interval for inbox messages (ms). */
export const INBOX_POLL_INTERVAL = 500;

/** Maximum mailbox messages before compaction. */
export const MAX_MAILBOX_MESSAGES = 500;

/** Environment variable to force plan mode on teammates. */
export const PLAN_MODE_REQUIRED_ENV_VAR = 'CODERIX_PLAN_MODE_REQUIRED';
