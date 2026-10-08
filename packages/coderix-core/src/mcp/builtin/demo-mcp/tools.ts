/**
 * Demo MCP — Tool Schemas
 *
 * A minimal, dependency-free reference server: a few safe tools that show the
 * full MCP tool contract (name / description / inputSchema) without touching
 * the filesystem, network or OS. Copy this directory as a starting point for a
 * new built-in MCP server.
 */

export const DEMO_TOOLS = [
  {
    name: 'echo',
    description: 'Echo the provided message back. Useful for verifying connectivity.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message to echo back.',
        },
      },
      required: ['message'],
    },
  },

  {
    name: 'get_time',
    description: 'Return the current date and time as an ISO-8601 string.',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description:
            "Optional IANA timezone (e.g. \"Asia/Shanghai\"). Defaults to the server's local timezone.",
        },
      },
      required: [],
    },
  },

  {
    name: 'calc',
    description:
      'Evaluate a basic arithmetic operation on two numbers. ' +
      'Supported operations: add, subtract, multiply, divide.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['add', 'subtract', 'multiply', 'divide'],
          description: 'The arithmetic operation to apply.',
        },
        a: { type: 'number', description: 'Left operand.' },
        b: { type: 'number', description: 'Right operand.' },
      },
      required: ['operation', 'a', 'b'],
    },
  },

  {
    name: 'server_info',
    description: 'Describe this demo MCP server: name, version and exposed tools.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
] as const;

export type DemoToolName = (typeof DEMO_TOOLS)[number]['name'];
