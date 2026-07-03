import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPrompt } from './render-prompt';

export interface PromptPackOptions {
  templatesDir?: string;
}

export class PromptPack {
  private readonly templatesDir: string;

  constructor(opts: PromptPackOptions = {}) {
    this.templatesDir = opts.templatesDir ?? join(__dirname, '..', 'templates');
  }

  render(ref: string, context: Record<string, unknown>): string {
    let template: string;
    try {
      template = readFileSync(join(this.templatesDir, ref), 'utf8');
    } catch {
      throw new Error(`PromptPack: no template found for ref "${ref}" in ${this.templatesDir}`);
    }
    return renderPrompt(template, context);
  }
}
