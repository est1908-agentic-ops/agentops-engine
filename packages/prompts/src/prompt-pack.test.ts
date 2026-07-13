import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptPack } from './prompt-pack';

describe('PromptPack', () => {
  it('renders a real bundled template by ref', () => {
    const pack = new PromptPack();
    const rendered = pack.render('implement.md', {
      taskId: 't1',
      goal: 'add a widget',
      fullVerifyFindings: '',
      reviewFindings: '',
    });
    expect(rendered).toContain('Task t1');
    expect(rendered).toContain('add a widget');
  });

  it('renders every built-in stage template without throwing, given the right context', () => {
    const pack = new PromptPack();
    expect(() => pack.render('context.md', { taskId: 't1', goal: 'g', issueBody: '' })).not.toThrow();
    expect(() => pack.render('assess.md', { taskId: 't1', goal: 'g' })).not.toThrow();
    expect(() => pack.render('design.md', { taskId: 't1', goal: 'g' })).not.toThrow();
    expect(() => pack.render('plan.md', { taskId: 't1', goal: 'g' })).not.toThrow();
    expect(() =>
      pack.render('implement.md', { taskId: 't1', goal: 'g', fullVerifyFindings: '', reviewFindings: '' }),
    ).not.toThrow();
    expect(() => pack.render('full_verify.md', { taskId: 't1', goal: 'g', verifyCommands: '' })).not.toThrow();
    expect(() => pack.render('review.md', { taskId: 't1', goal: 'g' })).not.toThrow();
  });

  it('renders design.md with the unattended-mode instruction and skill pointer', () => {
    const pack = new PromptPack();
    const rendered = pack.render('design.md', { taskId: 't1', goal: 'g' });
    expect(rendered).toContain('There is no human here. Do not ask anything');
    expect(rendered).toContain('design-brainstorm');
  });

  it('renders plan.md with the unattended-mode instruction and skill pointer', () => {
    const pack = new PromptPack();
    const rendered = pack.render('plan.md', { taskId: 't1', goal: 'g' });
    expect(rendered).toContain('There is no human here. Do not ask anything');
    expect(rendered).toContain('plan-writer');
  });

  it('renders the platform-chat template with a transcript', () => {
    const pack = new PromptPack();
    const rendered = pack.render('platform-chat.md', {
      taskId: 'chat-1',
      transcript: 'Operator: check the logs',
      hintRepos: '(none provided)',
    });
    expect(rendered).toContain('CHAT_TURN:');
    expect(rendered).toContain('check the logs');
  });

  it('renders the generic agent template with instructions and the FINDINGS contract', () => {
    const pack = new PromptPack();
    const rendered = pack.render('agent.md', { taskId: 'agent-1', instructions: 'Look for feature gaps.' });
    expect(rendered).toContain('Task agent-1');
    expect(rendered).toContain('Look for feature gaps.');
    expect(rendered).toContain('FINDINGS:');
  });

  it('throws a clear error for an unknown template ref', () => {
    const pack = new PromptPack();
    expect(() => pack.render('nonexistent.md', {})).toThrow(/nonexistent\.md/);
  });
});

describe('PromptPack with a custom templatesDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-prompts-test-'));
    writeFileSync(join(dir, 'custom.md'), 'Custom: {{value}}');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads templates from an overridden directory', () => {
    const pack = new PromptPack({ templatesDir: dir });
    expect(pack.render('custom.md', { value: 'x' })).toBe('Custom: x');
  });
});
