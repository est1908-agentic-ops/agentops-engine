import { GtdList, GtdListSchema } from '@agentops/contracts';
import { GtdStore } from './gtd-store';

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`usage: missing value for --${key}`);
    }
    flags[key] = value;
    i += 1;
  }
  return flags;
}

export async function handleAdd(args: string[], filePath?: string): Promise<void> {
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      break;
    }
    positional.push(arg);
    i += 1;
  }

  if (positional.length === 0) {
    throw new Error('usage: gtd add "<text>" [--list next] [--context @home] [--project +x] [--due 2026-07-20]');
  }

  const text = positional.join(' ');
  const flags = parseFlags(args.slice(i));

  let list: GtdList = 'inbox';
  if (flags.list) {
    list = GtdListSchema.parse(flags.list) as GtdList;
  }

  const store = new GtdStore(filePath);
  const task = await store.add(text, {
    list,
    context: flags.context,
    project: flags.project,
    due: flags.due,
  });

  console.log(`Added: ${task.text} (${task.id})`);
}

export async function handleList(args: string[], filePath?: string): Promise<void> {
  const flags = parseFlags(args);

  let list: GtdList | undefined;
  if (flags.list) {
    list = GtdListSchema.parse(flags.list) as GtdList;
  }

  const store = new GtdStore(filePath);
  const tasks = await store.list(list);

  if (tasks.length === 0) {
    console.log('No tasks');
    return;
  }

  for (const task of tasks) {
    const checkbox = task.done ? '[x]' : '[ ]';
    const meta = [task.context, task.project, task.due ? `!${task.due}` : null].filter(Boolean).join(' ');
    const metaStr = meta ? ` ${meta}` : '';
    console.log(`${checkbox} ${task.text} ^${task.id}${metaStr}`);
  }
}

export async function handleMove(args: string[], filePath?: string): Promise<void> {
  if (args.length < 2) {
    throw new Error('usage: gtd move <id> <list>');
  }

  const id = args[0];
  const list = GtdListSchema.parse(args[1]) as GtdList;

  const store = new GtdStore(filePath);
  await store.move(id, list);

  console.log(`Moved task ${id} to ${list}`);
}

export async function handleDone(args: string[], filePath?: string): Promise<void> {
  if (args.length < 1) {
    throw new Error('usage: gtd done <id>');
  }

  const id = args[0];

  const store = new GtdStore(filePath);
  await store.complete(id);

  console.log(`Completed task ${id}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('usage: gtd <command> [options]');
    console.log('  gtd add "<text>" [--list next] [--context @home] [--project +x] [--due 2026-07-20]');
    console.log('  gtd list [--list next]');
    console.log('  gtd move <id> <list>');
    console.log('  gtd done <id>');
    process.exit(1);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  try {
    switch (command) {
      case 'add':
        await handleAdd(commandArgs);
        break;
      case 'list':
        await handleList(commandArgs);
        break;
      case 'move':
        await handleMove(commandArgs);
        break;
      case 'done':
        await handleDone(commandArgs);
        break;
      default:
        throw new Error(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(`error: ${error.message}`);
    } else {
      console.error(`error:`, error);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('unexpected error:', error);
    process.exit(1);
  });
}
