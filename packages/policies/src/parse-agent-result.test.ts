import { describe, expect, it } from 'vitest';
import { parseAgentResult } from './parse-agent-result';

describe('parseAgentResult', () => {
  it('parses only the last AGENT_RESULT sentinel', () => {
    expect(parseAgentResult('AGENT_RESULT: {"old":1}\ntext\nAGENT_RESULT: {"ok":true}')).toEqual({
      ok: true,
    });
    expect(parseAgentResult('AGENT_RESULT: {"old":1}\nAGENT_RESULT: nope')).toBeUndefined();
  });

  it('requires the selected sentinel to be the final content line', () => {
    expect(parseAgentResult('AGENT_RESULT: {"ok":true}\ntrailing text')).toBeUndefined();
    expect(parseAgentResult('AGENT_RESULT:\n{"ok":true}')).toBeUndefined();
    expect(parseAgentResult('AGENT_RESULT: {"ok":true}\r\n \t\r\n')).toEqual({ ok: true });
  });

  it('selects a valid final marker but does not fall back from a malformed one', () => {
    expect(parseAgentResult('AGENT_RESULT: {"old":true}\nAGENT_RESULT: {"ok":true}\n')).toEqual({
      ok: true,
    });
    expect(parseAgentResult('AGENT_RESULT: {"old":true}\nAGENT_RESULT: nope\n')).toBeUndefined();
  });

  it.each(['null', 'true', '42', '"value"', '[]', '{}'])('accepts valid JSON value %s', (value) => {
    expect(parseAgentResult(`AGENT_RESULT: ${value}`)).toEqual(JSON.parse(value));
  });
});
