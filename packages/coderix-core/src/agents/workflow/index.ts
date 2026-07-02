import { schema } from './schema.js';
import { execute } from './executor.js';

export default {
  name: 'workflow',
  schema,
  executor: execute,
};
