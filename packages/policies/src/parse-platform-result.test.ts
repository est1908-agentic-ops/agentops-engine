import { describe, expect, it } from 'vitest';
import { parsePlatformResult } from './parse-platform-result';

describe('parsePlatformResult', () => {
  it('parses a well-formed sentinel line', () => {
    const text = [
      'I looked at the last three failures.',
      'PLATFORM_RESULT: {"summary": "all quiet", "actionsTaken": [], "proposedFixes": []}',
    ].join('\n');

    const result = parsePlatformResult(text);

    expect(result.parseable).toBe(true);
    expect(result.payload.summary).toBe('all quiet');
    expect(result.payload.actionsTaken).toEqual([]);
    expect(result.payload.proposedFixes).toEqual([]);
  });

  it('parses proposedFixes and actionsTaken when present', () => {
    const text =
      'PLATFORM_RESULT: {"summary": "found a bug", "actionsTaken": [{"type": "terminate", "workflowId": "w1", "reason": "stuck"}], "proposedFixes": [{"repo": "flair-hr/agentops-engine", "goal": "bound retries"}]}';

    const result = parsePlatformResult(text);

    expect(result.parseable).toBe(true);
    expect(result.payload.actionsTaken).toHaveLength(1);
    expect(result.payload.proposedFixes).toHaveLength(1);
  });

  it('is unparseable when the sentinel is missing', () => {
    const result = parsePlatformResult('just some free text, no sentinel here');

    expect(result.parseable).toBe(false);
  });

  it('is unparseable when the JSON after the sentinel is malformed', () => {
    const result = parsePlatformResult('PLATFORM_RESULT: {not valid json');

    expect(result.parseable).toBe(false);
  });

  it('is unparseable when the JSON does not match the schema', () => {
    const result = parsePlatformResult('PLATFORM_RESULT: {"actionsTaken": []}');

    expect(result.parseable).toBe(false);
  });

  it('uses the last sentinel line when more than one is present', () => {
    const text = [
      'PLATFORM_RESULT: {"summary": "draft, ignore this one"}',
      'more reasoning...',
      'PLATFORM_RESULT: {"summary": "final answer"}',
    ].join('\n');

    const result = parsePlatformResult(text);

    expect(result.parseable).toBe(true);
    expect(result.payload.summary).toBe('final answer');
  });
});
