import { describe, it, expect, vi } from 'vitest';
import { ensureSearchAttributes, CUSTOM_SEARCH_ATTRIBUTES } from './ensure-search-attributes';

const KEYWORD = 2; // temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD

function fakeConn(impl?: (req: unknown) => Promise<unknown>) {
  const addSearchAttributes = vi.fn(impl ?? (async () => ({})));
  return { conn: { operatorService: { addSearchAttributes } }, addSearchAttributes };
}

describe('ensureSearchAttributes', () => {
  it('registers each custom attribute as Keyword in the namespace', async () => {
    const { conn, addSearchAttributes } = fakeConn();
    await ensureSearchAttributes(conn, 'dev-agents');
    expect(addSearchAttributes).toHaveBeenCalledTimes(CUSTOM_SEARCH_ATTRIBUTES.length);
    for (const name of CUSTOM_SEARCH_ATTRIBUTES) {
      expect(addSearchAttributes).toHaveBeenCalledWith({ namespace: 'dev-agents', searchAttributes: { [name]: KEYWORD } });
    }
  });

  it('defaults the namespace to "default" when unset', async () => {
    const { conn, addSearchAttributes } = fakeConn();
    await ensureSearchAttributes(conn, undefined);
    expect(addSearchAttributes).toHaveBeenCalledWith({ namespace: 'default', searchAttributes: { project: KEYWORD } });
  });

  it('swallows an already-exists error (idempotent per attribute)', async () => {
    const { conn } = fakeConn(async () => {
      throw new Error('search attribute project already exists');
    });
    await expect(ensureSearchAttributes(conn, 'dev-agents')).resolves.toBeUndefined();
  });

  it('rethrows a non-already-exists error', async () => {
    const { conn } = fakeConn(async () => {
      throw new Error('connection refused');
    });
    await expect(ensureSearchAttributes(conn, 'dev-agents')).rejects.toThrow(/connection refused/);
  });
});
