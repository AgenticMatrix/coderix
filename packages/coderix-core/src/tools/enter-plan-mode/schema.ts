import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'EnterPlanMode',
  description:
    'Use this tool proactively when you are about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.\n\n' +
    '## When to Use This Tool\n\n' +
    '**Prefer using EnterPlanMode** for implementation tasks unless they are simple. Use it when ANY of these conditions apply:\n\n' +
    '1. **New Feature Implementation** — Adding meaningful new functionality\n' +
    '   - Example: "Add a logout button" — where should it go? What should happen on click?\n' +
    '   - Example: "Add form validation" — what rules? What error messages?\n\n' +
    '2. **Multiple Valid Approaches** — The task can be solved in several different ways\n' +
    '   - Example: "Add caching to the API" — could use Redis, in-memory, file-based, etc.\n' +
    '   - Example: "Improve performance" — many optimization strategies possible\n\n' +
    '3. **Code Modifications** — Changes that affect existing behavior or structure\n' +
    '   - Example: "Update the login flow" — what exactly should change?\n' +
    '   - Example: "Refactor this component" — what is the target architecture?\n\n' +
    '4. **Architectural Decisions** — The task requires choosing between patterns or technologies\n' +
    '   - Example: "Add real-time updates" — WebSockets vs SSE vs polling\n' +
    '   - Example: "Implement state management" — Redux vs Context vs custom solution\n\n' +
    '5. **Multi-File Changes** — The task will likely touch more than 2-3 files\n' +
    '   - Example: "Refactor the authentication system"\n' +
    '   - Example: "Add a new API endpoint with tests"\n\n' +
    '6. **Unclear Requirements** — You need to explore before understanding the full scope\n' +
    '   - Example: "Make the app faster" — need to profile and identify bottlenecks\n' +
    '   - Example: "Fix the bug in checkout" — need to investigate root cause\n\n' +
    '7. **User Preferences Matter** — The implementation could reasonably go multiple ways\n' +
    '   - If you would use AskUserQuestion to clarify the approach, use EnterPlanMode instead\n' +
    '   - Plan mode lets you explore first, then present options with context\n\n' +
    '8. **High-Impact Restructuring** — The task will significantly restructure existing code and getting buy-in first reduces risk\n' +
    '   - Example: "Redesign the authentication system"\n' +
    '   - Example: "Migrate from one state management approach to another"\n\n' +
    '## When NOT to Use This Tool\n\n' +
    'Only skip EnterPlanMode for simple tasks:\n' +
    '- Single-line or few-line fixes (typos, obvious bugs, small tweaks)\n' +
    '- Adding a single function with clear requirements\n' +
    '- Tasks where the user has given very specific, detailed instructions\n' +
    '- Pure research/exploration tasks (use the Agent tool with explore agent instead)\n\n' +
    '## Examples\n\n' +
    '### GOOD — Use EnterPlanMode:\n' +
    'User: "Add user authentication to the app"\n' +
    '- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)\n\n' +
    'User: "Optimize the database queries"\n' +
    '- Multiple approaches possible, need to profile first, significant impact\n\n' +
    'User: "Implement dark mode"\n' +
    '- Architectural decision on theme system, affects many components\n\n' +
    'User: "Add a delete button to the user profile"\n' +
    '- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates\n\n' +
    'User: "Update the error handling in the API"\n' +
    '- Affects multiple files, user should approve the approach\n\n' +
    '### BAD — Do NOT use EnterPlanMode:\n' +
    'User: "Fix the typo in the README"\n' +
    '- Straightforward, no planning needed\n\n' +
    'User: "Add a console.log to debug this function"\n' +
    '- Simple, obvious implementation\n\n' +
    'User: "What files handle routing?"\n' +
    '- Research task, not implementation planning\n\n' +
    '## Important Notes\n\n' +
    '- This tool REQUIRES user approval — they must consent to entering plan mode\n' +
    '- If unsure whether to use it, err on the side of planning — it is better to get alignment upfront than to redo work\n' +
    '- Users appreciate being consulted before significant changes are made to their codebase',
  input_schema: {
    type: 'object',
    properties: {},
  },
  _meta: {
    riskLevel: 'safe',
    isConcurrencySafe: true,
  },
};
