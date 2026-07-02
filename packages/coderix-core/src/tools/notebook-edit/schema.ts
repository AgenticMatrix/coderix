import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'notebook-edit',
  description:
    'Read or modify a Jupyter notebook (.ipynb file). Supports listing cells, reading a cell, replacing cell source, inserting new cells, and deleting cells.',
  input_schema: {
    type: 'object',
    properties: {
      notebook_path: {
        type: 'string',
        description: 'Absolute path to the .ipynb file.',
      },
      action: {
        type: 'string',
        enum: ['list', 'read', 'replace', 'insert', 'delete'],
        description: 'Operation to perform on the notebook.',
      },
      cell_index: {
        type: 'integer',
        description: 'Zero-based cell index for read/replace/delete actions.',
      },
      cell_type: {
        type: 'string',
        enum: ['code', 'markdown'],
        description: 'Cell type for insert action.',
      },
      source: {
        type: 'string',
        description: 'New cell source (for replace or insert actions).',
      },
    },
    required: ['notebook_path', 'action'],
  },
  _meta: {
    riskLevel: 'mutation',
    isConcurrencySafe: false,
  },
};
