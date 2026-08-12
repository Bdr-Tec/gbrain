import { test, expect, describe } from 'bun:test';
import { parseAuthCreateArgs } from '../src/commands/auth.ts';

describe('parseAuthCreateArgs', () => {
  test('bare name (no flag) resolves the name — regression for the dropped-name bug', () => {
    // Pre-fix this returned name='' because rest[takesIdx+1] === rest[0] when
    // takesIdx === -1, excluding the only positional from the search.
    expect(parseAuthCreateArgs(['claude-code'])).toEqual({ name: 'claude-code', takesHolders: undefined });
  });

  test('name + --takes-holders', () => {
    expect(parseAuthCreateArgs(['claude-code', '--takes-holders', 'world,garry'])).toEqual({
      name: 'claude-code',
      takesHolders: ['world', 'garry'],
    });
  });

  test('--takes-holders before the name still finds the name', () => {
    expect(parseAuthCreateArgs(['--takes-holders', 'world', 'claude-code'])).toEqual({
      name: 'claude-code',
      takesHolders: ['world'],
    });
  });

  test('the takes-holders value is not mistaken for the name', () => {
    // 'world' is the flag value, 'mybot' is the name.
    expect(parseAuthCreateArgs(['--takes-holders', 'world', 'mybot']).name).toBe('mybot');
  });

  test('no name → empty string (caller prints usage)', () => {
    expect(parseAuthCreateArgs([]).name).toBe('');
    expect(parseAuthCreateArgs(['--takes-holders', 'world']).name).toBe('');
  });

  test('takes-holders trims + drops empties', () => {
    expect(parseAuthCreateArgs(['n', '--takes-holders', ' world , , garry ']).takesHolders).toEqual(['world', 'garry']);
  });

  test('--scopes: comma and/or whitespace separated, value excluded from positional search (#4043)', () => {
    expect(parseAuthCreateArgs(['harness', '--scopes', 'read,write']).scopes).toEqual(['read', 'write']);
    expect(parseAuthCreateArgs(['--scopes', 'read write', 'harness'])).toMatchObject({
      name: 'harness',
      scopes: ['read', 'write'],
    });
    expect(parseAuthCreateArgs(['harness', '--scopes', ' read ,  write ']).scopes).toEqual(['read', 'write']);
  });

  test('--scopes with both flags present still resolves the name', () => {
    expect(
      parseAuthCreateArgs(['--takes-holders', 'world', '--scopes', 'read,write', 'harness']).name,
    ).toBe('harness');
  });

  test('--scopes absent → no scopes key (grandfather lane); empty value → empty array for create() to refuse', () => {
    expect('scopes' in parseAuthCreateArgs(['n'])).toBe(false);
    expect(parseAuthCreateArgs(['n', '--scopes', ',']).scopes).toEqual([]);
  });
});
