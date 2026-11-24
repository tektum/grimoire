import { describe, expect, it, vi } from 'vitest';
import { formatBytes, lazyLimits, tooLargeMessage, tooManyMessage, uploadLimitsOf } from '../../src/editor/attachments/limits';

describe('the size in the message', () => {
  it.each([
    [26_214_400, '25 MB'],
    [10_485_760, '10 MB'],
    [1_572_864, '1.5 MB'],
    [1_048_576, '1 MB'],
    [524_288, '512 KB'],
    [1_024, '1 KB'],
    [1_073_741_824, '1 GB'],
    [2_684_354_560, '2.5 GB'],
    [800, '800 bytes'],
    [1, '1 byte'],
  ])('%i is %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe('the limits the server announces', () => {
  it('reads the two numbers of the client configuration', () => {
    expect(uploadLimitsOf({ maxAttachmentBytes: 26_214_400, pendingUploadsMax: 10, collabUrl: 'x' })).toEqual({ maxBytes: 26_214_400, pendingMax: 10 });
  });

  it.each([[undefined], [null], ['Saved text'], [{}], [{ maxAttachmentBytes: null, pendingUploadsMax: null }], [{ maxAttachmentBytes: 'big', pendingUploadsMax: -1 }], [{ maxAttachmentBytes: 0 }]])(
    'knows nothing from %j',
    (data) => {
      expect(uploadLimitsOf(data)).toEqual({});
    },
  );

  it('keeps each number on its own', () => {
    expect(uploadLimitsOf({ maxAttachmentBytes: 1_048_576 })).toEqual({ maxBytes: 1_048_576 });
    expect(uploadLimitsOf({ pendingUploadsMax: 3 })).toEqual({ pendingMax: 3 });
  });
});

describe('the two messages', () => {
  it('say the limit when it is known, and are the plain texts when it is not', () => {
    expect(tooLargeMessage({ maxBytes: 26_214_400 })).toBe('That file is over 25 MB');
    expect(tooLargeMessage({})).toBe('That file is too large');
    expect(tooLargeMessage(undefined)).toBe('That file is too large');
    expect(tooManyMessage({ pendingMax: 10 })).toBe('Too many uploads at once (10 is the most). Wait a moment.');
    expect(tooManyMessage({})).toBe('Too many uploads at once. Wait a moment.');
    expect(tooManyMessage(undefined)).toBe('Too many uploads at once. Wait a moment.');
  });
});

describe('asking for the limits', () => {
  it('asks once, when first needed, and keeps the answer', async () => {
    const GET = vi.fn(async () => ({ data: { maxAttachmentBytes: 1_048_576, pendingUploadsMax: 4 }, response: new Response('{}', { status: 200 }) }));
    const limits = lazyLimits({ GET } as never);
    expect(GET).not.toHaveBeenCalled();
    expect(await limits()).toEqual({ maxBytes: 1_048_576, pendingMax: 4 });
    expect(await limits()).toEqual({ maxBytes: 1_048_576, pendingMax: 4 });
    expect(GET).toHaveBeenCalledTimes(1);
    expect(GET).toHaveBeenCalledWith('/v1/config');
  });

  it('knows nothing after a failed request, and asks again next time', async () => {
    const GET = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ error: {}, response: new Response('{}', { status: 503 }) }).mockResolvedValue({ data: { pendingUploadsMax: 2 }, response: new Response('{}', { status: 200 }) });
    const limits = lazyLimits({ GET } as never);
    expect(await limits()).toEqual({});
    expect(await limits()).toEqual({});
    expect(await limits()).toEqual({ pendingMax: 2 });
    expect(GET).toHaveBeenCalledTimes(3);
  });
});
