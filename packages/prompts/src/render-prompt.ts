export class MissingTemplateVariableError extends Error {
  constructor(key: string) {
    super(`renderPrompt: template references "{{${key}}}" but no such key was provided in context`);
  }
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

export function renderPrompt(template: string, context: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    if (!(key in context)) {
      throw new MissingTemplateVariableError(key);
    }
    return String(context[key]);
  });
}
