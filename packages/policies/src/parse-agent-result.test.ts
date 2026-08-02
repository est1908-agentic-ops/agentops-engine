import { describe, expect, it } from 'vitest';
import { parseAgentResult } from './parse-agent-result';

describe('parseAgentResult', () => {
  it('parses only the last AGENT_RESULT sentinel', () => {
    expect(parseAgentResult('AGENT_RESULT: {"old":1}\ntext\nAGENT_RESULT: {"ok":true}')).toEqual({
      ok: true,
    });
    expect(parseAgentResult('AGENT_RESULT: {"old":1}\nAGENT_RESULT: nope')).toBeUndefined();
  });

  it.each(['null', 'true', '42', '"value"', '[]', '{}'])('accepts valid JSON value %s', (value) => {
    expect(parseAgentResult(`AGENT_RESULT: ${value}`)).toEqual(JSON.parse(value));
  });
});
