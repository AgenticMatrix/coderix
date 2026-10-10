/**
 * cad-control MCP — Tool Schemas
 *
 * The CAD-control server exposes the cad_harness `cad` skill's CLI surface
 * (gen/export/inspect/snapshot/artifact) as MCP tools, plus workspace artifact
 * listing and a viewer handoff. Every tool takes a `dir` (the conversation
 * workspace) so targets resolve from it exactly like the `cad` skill requires.
 */

export const CAD_CONTROL_TOOLS = [
  {
    name: 'list_artifacts',
    description:
      'List CAD artifacts (.step.py/.step/.stp/.glb/.stl/.3mf) under a workspace directory.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Absolute workspace directory to scan.' },
      },
      required: ['dir'],
    },
  },
  {
    name: 'render',
    description:
      'Render a build123d gen_step() source (or re-render a generated model) into a GLB/topology package. Runs cad_harness `scripts/gen`. Pass write=true to also emit the sibling .step file.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Workspace cwd for the command.' },
        target: { type: 'string', description: 'cwd-relative .step.py generator target.' },
        write: { type: 'boolean', description: 'Also write the sibling .step file (default false).' },
      },
      required: ['dir', 'target'],
    },
  },
  {
    name: 'export',
    description:
      'Export a CAD model (gen_step() source or imported STEP/STP) to an STL/3MF/GLB mesh. Runs cad_harness `scripts/export`.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Workspace cwd for the command.' },
        target: { type: 'string', description: 'cwd-relative .step.py or .step/.stp target.' },
        format: {
          type: 'string',
          enum: ['stl', '3mf', 'glb'],
          description: 'Mesh format to export.',
        },
      },
      required: ['dir', 'target', 'format'],
    },
  },
  {
    name: 'inspect',
    description:
      'Inspect/validate a CAD model. Runs cad_harness `scripts/inspect` with a command (refs, validate, measure, align, frame, diff). JSON output.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Workspace cwd for the command.' },
        target: { type: 'string', description: 'cwd-relative .step.py or .step/.stp target.' },
        command: {
          type: 'string',
          enum: ['refs', 'validate', 'measure', 'align', 'frame', 'diff'],
          description: 'Inspect subcommand (default: refs).',
        },
      },
      required: ['dir', 'target'],
    },
  },
  {
    name: 'snapshot',
    description:
      'Render a PNG/GIF visual review snapshot of a model. Runs cad_harness `scripts/snapshot`.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Workspace cwd for the command.' },
        target: { type: 'string', description: 'cwd-relative model target.' },
        theme: { type: 'string', description: 'Optional viewer theme (e.g. workbench-light).' },
        display: { type: 'string', description: 'Optional display option.' },
      },
      required: ['dir', 'target'],
    },
  },
  {
    name: 'artifact_build',
    description:
      'Build a render package from an imported STEP file on demand. Runs cad_harness `scripts/artifact`.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Workspace cwd for the command.' },
        file: { type: 'string', description: 'cwd-relative imported .step/.stp file.' },
      },
      required: ['dir', 'file'],
    },
  },
  {
    name: 'focus',
    description:
      'Return the cad-viewer URL for an artifact so the on-screen viewer can navigate to it.',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: 'Absolute workspace directory.' },
        file: { type: 'string', description: 'cwd-relative artifact path.' },
      },
      required: ['dir', 'file'],
    },
  },
] as const;

export type CadControlToolName = (typeof CAD_CONTROL_TOOLS)[number]['name'];
