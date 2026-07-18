import { describe, expect, it } from 'vitest';
import { parse, serialize } from './markdown-store';

describe('markdown-store', () => {
  describe('parse and serialize', () => {
    it('round-trips a simple markdown document', () => {
      const md = `# GTD

## Inbox
- [ ] Buy milk

## Next

## Waiting

## Someday

## Done
`;

      const doc = parse(md);
      expect(doc.tasks).toHaveLength(1);
      expect(doc.tasks[0]).toMatchObject({
        text: 'Buy milk',
        list: 'inbox',
        done: false,
      });

      const serialized = serialize(doc);
      const reparsed = parse(serialized);
      expect(reparsed.tasks).toEqual(doc.tasks.map(t => ({ ...t, id: expect.any(String) })));
    });

    it('extracts inline metadata from task text', () => {
      const md = `# GTD

## Next
- [ ] Ship release @laptop +release !2026-07-20 ^k2p9

## Inbox

## Waiting

## Someday

## Done
`;

      const doc = parse(md);
      expect(doc.tasks).toHaveLength(1);
      expect(doc.tasks[0]).toMatchObject({
        id: 'k2p9',
        text: 'Ship release',
        list: 'next',
        context: '@laptop',
        project: '+release',
        due: '2026-07-20',
        done: false,
      });
    });

    it('serializes metadata back in the same order', () => {
      const doc = {
        tasks: [
          {
            id: 'test',
            text: 'Task text',
            list: 'next' as const,
            context: '@home',
            project: '+project',
            due: '2026-08-01',
            done: false,
          },
        ],
        preserved: [],
      };

      const serialized = serialize(doc);
      expect(serialized).toContain('- [ ] Task text @home +project !2026-08-01 ^test');
    });

    it('marks completed tasks with [x]', () => {
      const doc = {
        tasks: [
          {
            id: 'a1',
            text: 'Completed task',
            list: 'done' as const,
            done: true,
          },
        ],
        preserved: [],
      };

      const serialized = serialize(doc);
      expect(serialized).toContain('- [x] Completed task ^a1');
    });

    it('generates a stable id for tasks without one', () => {
      const doc = {
        tasks: [
          {
            id: '',
            text: 'Buy milk',
            list: 'inbox' as const,
            done: false,
          },
        ],
        preserved: [],
      };

      const serialized1 = serialize(doc);
      const serialized2 = serialize(doc);

      expect(serialized1).toBe(serialized2);

      const parsed1 = parse(serialized1);
      const parsed2 = parse(serialized2);

      expect(parsed1.tasks[0].id).toBe(parsed2.tasks[0].id);
    });

    it('preserves unknown sections verbatim', () => {
      const md = `# GTD

## Inbox
- [ ] Buy milk

## Projects
- Personal project notes

## Next

## Waiting

## Someday

## Done
`;

      const doc = parse(md);
      const serialized = serialize(doc);

      expect(serialized).toContain('## Projects');
      expect(serialized).toContain('Personal project notes');
    });

    it('preserves unrecognized lines within sections', () => {
      const md = `# GTD

## Inbox
- [ ] Buy milk
Some random note

## Next

## Waiting

## Someday

## Done
`;

      const doc = parse(md);
      const serialized = serialize(doc);

      expect(serialized).toContain('Some random note');
    });

    it('is idempotent: parse -> serialize -> parse produces the same result', () => {
      const md = `# GTD

## Inbox
- [ ] Task 1
- [ ] Task 2 @home +proj !2026-08-15

## Next
- [ ] Next item ^abc1

## Waiting
- [ ] Waiting for response

## Someday
- [ ] Learn Rust

## Done
- [x] Completed task ^xyz9
`;

      const doc1 = parse(md);
      const serialized = serialize(doc1);
      const doc2 = parse(serialized);

      expect(doc2.tasks).toEqual(doc1.tasks.map(t => ({ ...t, id: expect.any(String) })));
    });

    it('handles empty sections', () => {
      const md = `# GTD

## Inbox

## Next

## Waiting

## Someday

## Done
`;

      const doc = parse(md);
      expect(doc.tasks).toHaveLength(0);

      const serialized = serialize(doc);
      expect(serialized).toContain('## Inbox');
      expect(serialized).toContain('## Next');
      expect(serialized).toContain('## Waiting');
      expect(serialized).toContain('## Someday');
      expect(serialized).toContain('## Done');
    });

    it('allows parsing tasks without ids and assigns them on serialize', () => {
      const md = `# GTD

## Inbox
- [ ] Buy milk

## Next

## Waiting

## Someday

## Done
`;

      const doc = parse(md);
      expect(doc.tasks[0].id).toBe('');

      const serialized = serialize(doc);
      expect(serialized).toMatch(/\^[a-f0-9]{4}\s*$/m);

      const reparsed = parse(serialized);
      expect(reparsed.tasks[0].id).toMatch(/^[a-f0-9]{4}$/);
    });

    it('does not duplicate preserved content after final GTD section on multiple round-trips', () => {
      const md = `# GTD

## Inbox
- [ ] Buy milk

## Next

## Waiting

## Someday

## Done

## Projects
Personal project notes
`;

      let doc = parse(md);
      let serialized = serialize(doc);

      expect(serialized).toContain('## Projects');
      const firstProjectCount = (serialized.match(/## Projects/g) || []).length;
      expect(firstProjectCount).toBe(1);

      doc = parse(serialized);
      serialized = serialize(doc);

      expect(serialized).toContain('## Projects');
      const secondProjectCount = (serialized.match(/## Projects/g) || []).length;
      expect(secondProjectCount).toBe(1);

      doc = parse(serialized);
      serialized = serialize(doc);

      expect(serialized).toContain('## Projects');
      const thirdProjectCount = (serialized.match(/## Projects/g) || []).length;
      expect(thirdProjectCount).toBe(1);
    });

    it('produces stable serialized text across repeated round-trips (no blank-line growth)', () => {
      const md = `# GTD

## Inbox
- [ ] Buy milk ^dc4d

## Next

## Waiting

## Someday

## Done

## Project Notes
some human notes
- keep me
`;

      // First round-trip normalizes; every subsequent round-trip must be a no-op.
      const stable = serialize(parse(md));
      const again = serialize(parse(stable));
      expect(again).toBe(stable);

      // Preserved human content survives, and no blank lines accumulate.
      expect(stable).toContain('## Project Notes');
      expect(stable).toContain('- keep me');
      const blankCount = (s: string) => (s.match(/^$/gm) || []).length;
      expect(blankCount(again)).toBe(blankCount(stable));
    });
  });
});
