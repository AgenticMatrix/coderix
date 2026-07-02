/**
 * Tests for flag-validator.ts — flag parsing and validation utilities.
 */
import { describe, it, expect } from 'vitest';
import {
  validateFlagArgument,
  validateFlags,
  FLAG_PATTERN,
  type ExternalCommandConfig,
} from '../../../packages/coderix-core/src/tools/bash/flag-validator.js';

describe('FLAG_PATTERN', () => {
  it('should match short flags', () => {
    expect(FLAG_PATTERN.test('-a')).toBe(true);
    expect(FLAG_PATTERN.test('-n')).toBe(true);
  });

  it('should match long flags', () => {
    expect(FLAG_PATTERN.test('--name-only')).toBe(true);
    expect(FLAG_PATTERN.test('--color')).toBe(true);
  });

  it('should not match non-flags', () => {
    expect(FLAG_PATTERN.test('file.txt')).toBe(false);
    expect(FLAG_PATTERN.test('123')).toBe(false);
    expect(FLAG_PATTERN.test('-')).toBe(false);
  });
});

describe('validateFlagArgument', () => {
  it('should reject none type (has no argument)', () => {
    expect(validateFlagArgument('anything', 'none')).toBe(false);
  });

  it('should validate number type', () => {
    expect(validateFlagArgument('42', 'number')).toBe(true);
    expect(validateFlagArgument('0', 'number')).toBe(true);
    expect(validateFlagArgument('abc', 'number')).toBe(false);
    expect(validateFlagArgument('', 'number')).toBe(false);
  });

  it('should accept any string for string type', () => {
    expect(validateFlagArgument('hello', 'string')).toBe(true);
    expect(validateFlagArgument('', 'string')).toBe(true);
    expect(validateFlagArgument('.', 'string')).toBe(true);
  });

  it('should validate char type', () => {
    expect(validateFlagArgument('a', 'char')).toBe(true);
    expect(validateFlagArgument('ab', 'char')).toBe(false);
    expect(validateFlagArgument('', 'char')).toBe(false);
  });

  it('should validate {} type', () => {
    expect(validateFlagArgument('{}', '{}')).toBe(true);
    expect(validateFlagArgument('{', '{}')).toBe(false);
    expect(validateFlagArgument('xarg', '{}')).toBe(false);
  });

  it('should validate EOF type', () => {
    expect(validateFlagArgument('EOF', 'EOF')).toBe(true);
    expect(validateFlagArgument('END', 'EOF')).toBe(false);
    expect(validateFlagArgument('', 'EOF')).toBe(false);
  });
});

describe('validateFlags', () => {
  const simpleConfig: ExternalCommandConfig = {
    safeFlags: {
      '--name-only': 'none',
      '-n': 'none',
      '--max-count': 'number',
      '-A': 'number',
      '--color': 'string',
      '-v': 'none',
    },
  };

  it('should pass all known flags', () => {
    expect(validateFlags(
      ['--name-only', '-v', '--max-count', '10', 'HEAD'],
      0,
      simpleConfig,
    )).toBe(true);
  });

  it('should reject unknown flags', () => {
    expect(validateFlags(
      ['--dangerous-flag'],
      0,
      simpleConfig,
    )).toBe(false);
  });

  it('should validate number argument', () => {
    // --max-count 10 is valid
    expect(validateFlags(
      ['--max-count', '10'],
      0,
      simpleConfig,
    )).toBe(true);
  });

  it('should reject missing number argument', () => {
    // --max-count without a number
    expect(validateFlags(
      ['--max-count'],
      0,
      simpleConfig,
    )).toBe(false);
  });

  it('should handle -- end-of-options', () => {
    // Everything after -- is positional
    expect(validateFlags(
      ['-v', '--', '--dangerous', 'file.txt'],
      0,
      simpleConfig,
    )).toBe(true);
  });

  it('should handle --flag=value format', () => {
    const config: ExternalCommandConfig = {
      safeFlags: {
        '--color': 'string',
      },
    };
    expect(validateFlags(
      ['--color=auto'],
      0,
      config,
    )).toBe(true);
  });

  it('should reject --flag= for none-type flags', () => {
    expect(validateFlags(
      ['--name-only='],
      0,
      simpleConfig,
    )).toBe(false);
  });

  it('should handle git -<number> shorthand', () => {
    expect(validateFlags(
      ['-5', 'HEAD'],
      0,
      simpleConfig,
      { commandName: 'git' },
    )).toBe(true);
  });

  it('should attach numeric values to grep/rg flags', () => {
    const rgConfig: ExternalCommandConfig = {
      safeFlags: {
        '-A': 'number',
        '-C': 'number',
        '-n': 'none',
      },
    };
    // -A20 should be parsed as -A 20
    expect(validateFlags(
      ['-A20', '-n', 'pattern'],
      0,
      rgConfig,
      { commandName: 'rg' },
    )).toBe(true);
  });

  it('should reject bundled short flags with arg-taking flag', () => {
    const config: ExternalCommandConfig = {
      safeFlags: {
        '-v': 'none',
        '-n': 'none',
        '-A': 'number',  // Takes argument — cannot be bundled
      },
    };
    // -vn is fine (both no-arg)
    expect(validateFlags(
      ['-vn', 'file'],
      0,
      config,
    )).toBe(true);

    // -vA should be rejected because -A takes an argument
    expect(validateFlags(
      ['-vA', 'file'],
      0,
      config,
    )).toBe(false);
  });

  it('should call additionalCommandIsDangerousCallback when present', () => {
    const config: ExternalCommandConfig = {
      safeFlags: {},
      additionalCommandIsDangerousCallback: (_raw, args) => {
        // Block positional args like "newbranch"
        return args.some(a => a === 'newbranch');
      },
    };
    // No positional args — flag validation passes, callback passes
    expect(validateFlags([], 0, config)).toBe(true);

    // Has dangerous positional arg — callback blocks
    expect(validateFlags(['newbranch'], 0, config)).toBe(false);
  });
});
