import { describe, expect, it } from 'vitest';
import { renderPrompt, MissingTemplateVariableError } from './render-prompt';

describe('renderPrompt', () => {
  it('substitutes {{key}} placeholders', () => {
    const result = renderPrompt('Hello {{name}}, goal is {{goal}}.', { name: 'Ada', goal: 'ship it' });
    expect(result).toBe('Hello Ada, goal is ship it.');
  });

  it('substitutes the same key repeated multiple times', () => {
    const result = renderPrompt('{{x}} and {{x}} again', { x: 'foo' });
    expect(result).toBe('foo and foo again');
  });

  it('coerces non-string values to strings', () => {
    const result = renderPrompt('count: {{count}}', { count: 3 });
    expect(result).toBe('count: 3');
  });

  it('throws MissingTemplateVariableError when a referenced key is absent', () => {
    expect(() => renderPrompt('Hello {{name}}', {})).toThrow(MissingTemplateVariableError);
    expect(() => renderPrompt('Hello {{name}}', {})).toThrow(/name/);
  });

  it('ignores context keys the template does not reference', () => {
    const result = renderPrompt('Hello {{name}}', { name: 'Ada', unused: 'ignored' });
    expect(result).toBe('Hello Ada');
  });

  it('returns the template unchanged when it has no placeholders', () => {
    expect(renderPrompt('no placeholders here', {})).toBe('no placeholders here');
  });
});
