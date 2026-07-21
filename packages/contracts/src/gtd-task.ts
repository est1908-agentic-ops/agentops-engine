import { z } from 'zod';

export const GtdListSchema = z.enum(['inbox', 'next', 'waiting', 'someday', 'done']);
export type GtdList = z.infer<typeof GtdListSchema>;

const IsoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(dateStr: string): boolean {
  if (!IsoDateRegex.test(dateStr)) {
    return false;
  }
  const [year, month, day] = dateStr.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  // Basic check for month-specific day limits
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) {
    return day <= 29;
  }
  return day <= daysInMonth[month - 1];
}

export const GtdTaskSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  list: GtdListSchema,
  context: z.string().optional(),
  project: z.string().optional(),
  due: z.string().refine(isValidDate, 'Due date must be a valid date in YYYY-MM-DD format').optional(),
  done: z.boolean(),
});
export type GtdTask = z.infer<typeof GtdTaskSchema>;

export const PreservedBlockSchema = z.object({
  content: z.string(),
  position: z.enum(['before-inbox', 'after-inbox', 'after-next', 'after-waiting', 'after-someday', 'after-done', 'trailing']),
});
export type PreservedBlock = z.infer<typeof PreservedBlockSchema>;

export const GtdDocumentSchema = z.object({
  tasks: z.array(GtdTaskSchema),
  preserved: z.array(PreservedBlockSchema),
});
export type GtdDocument = z.infer<typeof GtdDocumentSchema>;
