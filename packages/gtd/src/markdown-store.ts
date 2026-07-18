import { GtdDocument, GtdTask, GtdList, GtdDocumentSchema, PreservedBlock } from '@agentops/contracts';
import { sha256 } from '@agentops/contracts';

const GTD_LISTS: GtdList[] = ['inbox', 'next', 'waiting', 'someday', 'done'];

function generateId(text: string, list: GtdList): string {
  const hash = sha256(`${text}:${list}`);
  return hash.slice(0, 4);
}

function parseInlineMetadata(text: string): {
  text: string;
  context?: string;
  project?: string;
  due?: string;
  id?: string;
} {
  let cleanText = text;
  let context: string | undefined;
  let project: string | undefined;
  let due: string | undefined;
  let id: string | undefined;

  const contextMatch = cleanText.match(/@(\S+)/);
  if (contextMatch) {
    context = `@${contextMatch[1]}`;
    cleanText = cleanText.replace(/@\S+/, '').trim();
  }

  const projectMatch = cleanText.match(/\+(\S+)/);
  if (projectMatch) {
    project = `+${projectMatch[1]}`;
    cleanText = cleanText.replace(/\+\S+/, '').trim();
  }

  const dueMatch = cleanText.match(/!(\d{4}-\d{2}-\d{2})/);
  if (dueMatch) {
    due = dueMatch[1];
    cleanText = cleanText.replace(/!\d{4}-\d{2}-\d{2}/, '').trim();
  }

  const idMatch = cleanText.match(/\^(\w+)$/);
  if (idMatch) {
    id = idMatch[1];
    cleanText = cleanText.replace(/\^\w+$/, '').trim();
  }

  return { text: cleanText, context, project, due, id };
}

function serializeInlineMetadata(task: GtdTask): string {
  const parts = [task.text];
  if (task.context) {
    parts.push(task.context);
  }
  if (task.project) {
    parts.push(task.project);
  }
  if (task.due) {
    parts.push(`!${task.due}`);
  }
  parts.push(`^${task.id}`);
  return parts.join(' ');
}

export function parse(md: string): GtdDocument {
  const lines = md.split('\n');
  const tasks: GtdTask[] = [];
  const preserved: Array<{ content: string; position: 'before-inbox' | 'after-inbox' | 'after-next' | 'after-waiting' | 'after-someday' | 'after-done' | 'trailing' }> = [];

  let currentList: GtdList | null = null;
  const currentSection: string[] = [];
  const beforeInbox: string[] = [];
  const afterInbox: string[] = [];
  const afterNext: string[] = [];
  const afterWaiting: string[] = [];
  const afterSomeday: string[] = [];
  const afterDone: string[] = [];
  const trailingContent: string[] = [];

  for (const line of lines) {
    if (line === '# GTD' || line.match(/^#\s+GTD\s*$/i)) {
      continue;
    }

    const headingMatch = line.match(/^##\s+(\w+)$/i);
    if (headingMatch) {
      const sectionName = headingMatch[1].toLowerCase();
      if (GTD_LISTS.includes(sectionName as GtdList)) {
        if (currentList === null) {
          beforeInbox.push(...currentSection);
        } else {
          const position = `after-${currentList}` as const;
          if (position === 'after-inbox') {
            afterInbox.push(...currentSection);
          } else if (position === 'after-next') {
            afterNext.push(...currentSection);
          } else if (position === 'after-waiting') {
            afterWaiting.push(...currentSection);
          } else if (position === 'after-someday') {
            afterSomeday.push(...currentSection);
          } else if (position === 'after-done') {
            afterDone.push(...currentSection);
          }
        }
        currentList = sectionName as GtdList;
        currentSection.length = 0;
      } else {
        currentSection.push(line);
      }
    } else if (line.match(/^-\s+\[([ x])\]\s+/)) {
      const checkboxMatch = line.match(/^-\s+\[([ x])\]\s+(.*?)$/);
      if (checkboxMatch) {
        const done = checkboxMatch[1] === 'x';
        const text = checkboxMatch[2];
        const metadata = parseInlineMetadata(text);

        if (currentList) {
          tasks.push({
            id: metadata.id || '',
            text: metadata.text,
            list: currentList,
            context: metadata.context,
            project: metadata.project,
            due: metadata.due,
            done,
          });
        } else {
          currentSection.push(line);
        }
      }
    } else {
      currentSection.push(line);
    }
  }

  if (currentList === null) {
    beforeInbox.push(...currentSection);
  } else {
    const position = `after-${currentList}` as const;
    if (position === 'after-inbox') {
      afterInbox.push(...currentSection);
    } else if (position === 'after-next') {
      afterNext.push(...currentSection);
    } else if (position === 'after-waiting') {
      afterWaiting.push(...currentSection);
    } else if (position === 'after-someday') {
      afterSomeday.push(...currentSection);
    } else if (position === 'after-done') {
      afterDone.push(...currentSection);
    }
  }

  // Trim leading/trailing blank lines so that blank section separators emitted
  // by serialize() are not captured as preserved content (which would otherwise
  // grow the file by a few blank lines on every parse->serialize round-trip).
  // Internal blank lines within genuine preserved content are kept.
  const pushPreserved = (lines: string[], position: PreservedBlock['position']) => {
    const content = lines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    if (content !== '') {
      preserved.push({ content, position });
    }
  };

  pushPreserved(beforeInbox, 'before-inbox');
  pushPreserved(afterInbox, 'after-inbox');
  pushPreserved(afterNext, 'after-next');
  pushPreserved(afterWaiting, 'after-waiting');
  pushPreserved(afterSomeday, 'after-someday');
  pushPreserved(afterDone, 'after-done');
  pushPreserved(trailingContent, 'trailing');

  const doc = { tasks, preserved };
  return GtdDocumentSchema.parse(doc);
}

export function serialize(doc: GtdDocument): string {
  const unidentifiedTasks = doc.tasks.filter((t) => !t.id);

  for (const task of unidentifiedTasks) {
    task.id = generateId(task.text, task.list);
  }

  const lines: string[] = [];

  for (const block of doc.preserved) {
    if (block.position === 'before-inbox') {
      lines.push(block.content);
      lines.push('');
    }
  }

  lines.push('# GTD');
  lines.push('');

  for (const list of GTD_LISTS) {
    lines.push(`## ${list.charAt(0).toUpperCase() + list.slice(1)}`);
    const tasksInList = doc.tasks.filter((t) => t.list === list);
    if (tasksInList.length === 0) {
      lines.push('');
    } else {
      for (const task of tasksInList) {
        const checkbox = task.done ? '[x]' : '[ ]';
        const text = serializeInlineMetadata(task);
        lines.push(`- ${checkbox} ${text}`);
      }
      lines.push('');
    }

    for (const block of doc.preserved) {
      if (block.position === `after-${list}`) {
        lines.push(block.content);
        lines.push('');
      }
    }
  }

  for (const block of doc.preserved) {
    if (block.position === 'trailing') {
      lines.push(block.content);
    }
  }

  return lines.join('\n').trim() + '\n';
}
