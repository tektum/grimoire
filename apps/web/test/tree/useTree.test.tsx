import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiLike } from '../../src/api/query';
import { HttpError, useCollectionTree } from '../../src/tree/useTree';
import '../support/dom';

const pages = [{ id: 'a0000000-0', urlId: 'a0000000', parentId: null, position: 'p1', title: 'One', icon: null }];
const fakeApi = (status = 200) => {
  const calls: unknown[] = [];
  const api = { GET: vi.fn((path: unknown, init: unknown) => { calls.push([path, init]); return Promise.resolve({ data: { pages }, response: new Response(null, { status }) }); }) } as unknown as ApiLike;
  return { api, calls };
};
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;

afterEach(() => { vi.useRealTimers(); });

describe('useCollectionTree', () => {
  it('reads the tree of the collection and returns its flat page list', async () => {
    const { api, calls } = fakeApi();
    const { result } = renderHook(() => useCollectionTree(api, 'c1'), { wrapper });
    await waitFor(() => { expect(result.current.data).toEqual(pages); });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject(['/v1/collections/{id}/tree', { params: { path: { id: 'c1' } } }]);
  });

  it('refetches exactly once more on the window focus event', async () => {
    const { api } = fakeApi();
    const { result } = renderHook(() => useCollectionTree(api, 'c1'), { wrapper });
    await waitFor(() => { expect(result.current.data).toBeDefined(); });
    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
    await waitFor(() => { expect(vi.mocked(api.GET)).toHaveBeenCalledTimes(2); });
    expect(vi.mocked(api.GET)).toHaveBeenCalledTimes(2);
  });

  it('refetches exactly once more every 60 s, and stops listening when it unmounts', async () => {
    vi.useFakeTimers();
    const { api } = fakeApi();
    const view = renderHook(() => useCollectionTree(api, 'c1'), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(vi.mocked(api.GET)).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(vi.mocked(api.GET)).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(120_000); });
    expect(vi.mocked(api.GET)).toHaveBeenCalledTimes(2);
  });

  it('fails with the status of an answer that was not 2xx', async () => {
    const { api } = fakeApi(404);
    const { result } = renderHook(() => useCollectionTree(api, 'c1'), { wrapper });
    await waitFor(() => { expect(result.current.error).toBeInstanceOf(HttpError); });
    expect(result.current.error?.status).toBe(404);
  });

  it('reuses the read that the minute started when the window gets the focus meanwhile, instead of cancelling it and asking again', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    const GET = vi.fn(async () => {
      reads += 1;
      if (reads > 1) await gate; // the first read answers at once; the one the minute starts stays open
      return { data: { pages }, response: new Response(null, { status: 200 }) };
    });
    const api = { GET } as unknown as ApiLike;
    renderHook(() => useCollectionTree(api, 'c1'), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(GET).toHaveBeenCalledTimes(2); // the minute's read is under way
    await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(10); });
    expect(GET).toHaveBeenCalledTimes(2); // the focus asked for nothing more
    release();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(GET).toHaveBeenCalledTimes(2);
  });
});
