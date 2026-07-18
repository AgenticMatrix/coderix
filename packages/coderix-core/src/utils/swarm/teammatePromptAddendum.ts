/**
 * Teammate system prompt addendum — builds team communication context
 * for agents running as teammates in a team.
 *
 * Unlike the static constant it replaced, this function generates a
 * dynamic prompt that includes the worker's own identity, the leader's
 * address, and a list of peer workers with their agentIds.
 */

export function buildTeammatePromptAddendum(opts: {
  myAgentId: string;
  myName: string;
  teamName: string;
  members: Array<{ agentId: string; name: string; agentType: string }>;
}): string {
  const peerList = opts.members
    .filter(m => m.agentId !== opts.myAgentId)
    .map(m => `  - ${m.name} (\`${m.agentId}\`) [${m.agentType}]`)
    .join('\n');

  return `
# Team Communication

You are "${opts.myName}" (\`${opts.myAgentId}\`) in team "${opts.teamName}".
The team leader is at "leader" — use SendMessage(to: "leader", text: "...") to report.

Peer workers:
${peerList || '  (none)'}

- SendMessage(to: "<agentId>") to message a specific teammate
- SendMessage(to: "*") to broadcast to all workers
- Just writing text in your response is NOT visible to others — you MUST use SendMessage
`;
}
