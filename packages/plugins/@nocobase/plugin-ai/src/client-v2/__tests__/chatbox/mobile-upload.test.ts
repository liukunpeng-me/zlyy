/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkMobileUploadSession,
  getMobileUploadSession,
  getMobileUploadUrl,
  MOBILE_UPLOAD_TOKEN_HEADER,
  pickNewAttachments,
  uploadMobileFile,
} from '../../ai-employees/chatbox/mobile-upload';

describe('getMobileUploadUrl', () => {
  const globals = window as unknown as Record<string, string | undefined>;

  afterEach(() => {
    delete globals.__nocobase_public_path__;
    delete globals.__nocobase_modern_client_prefix__;
  });

  describe('inside the modern client', () => {
    beforeEach(() => {
      globals.__nocobase_public_path__ = '/nocobase/v/';
      globals.__nocobase_modern_client_prefix__ = 'v';
      window.history.pushState({}, '', '/nocobase/v/admin');
    });

    it('builds an absolute url under the router basename', () => {
      const app = { router: { getBasename: () => '/nocobase/v' } };
      expect(getMobileUploadUrl(app, 'abc', 'https://example.com')).toBe(
        'https://example.com/nocobase/v/ai-mobile-upload/abc',
      );
    });

    it('falls back to the public path', () => {
      expect(getMobileUploadUrl({ getPublicPath: () => '/nocobase/v/' }, 'abc', 'https://example.com')).toBe(
        'https://example.com/nocobase/v/ai-mobile-upload/abc',
      );
    });
  });

  describe('inside the legacy client, where the route is not registered', () => {
    beforeEach(() => {
      globals.__nocobase_public_path__ = '/';
      globals.__nocobase_modern_client_prefix__ = 'v';
      window.history.pushState({}, '', '/admin');
    });

    it('points at the modern client prefix so the phone does not hit the legacy login guard', () => {
      expect(getMobileUploadUrl({ getPublicPath: () => '/' }, 'abc', 'https://example.com')).toBe(
        'https://example.com/v/ai-mobile-upload/abc',
      );
    });

    it('keeps the app public path and honors a custom modern client prefix', () => {
      globals.__nocobase_public_path__ = '/nocobase/';
      globals.__nocobase_modern_client_prefix__ = 'next';
      window.history.pushState({}, '', '/nocobase/admin');
      expect(getMobileUploadUrl({ getPublicPath: () => '/nocobase/' }, 'abc', 'https://example.com')).toBe(
        'https://example.com/nocobase/next/ai-mobile-upload/abc',
      );
    });
  });

  it('encodes the token so it cannot alter the path', () => {
    globals.__nocobase_public_path__ = '/v/';
    globals.__nocobase_modern_client_prefix__ = 'v';
    window.history.pushState({}, '', '/v/admin');
    expect(getMobileUploadUrl({ getPublicPath: () => '/v/' }, 'a/b?c', 'https://example.com')).toBe(
      'https://example.com/v/ai-mobile-upload/a%2Fb%3Fc',
    );
  });
});

describe('pickNewAttachments', () => {
  it('returns only attachments whose id is not in the chat box yet', () => {
    const existing = [{ id: 1, filename: 'a.png' }];
    const incoming = [
      { id: 1, filename: 'a.png' },
      { id: 2, filename: 'b.png' },
    ];
    expect(pickNewAttachments(existing, incoming)).toEqual([{ id: 2, filename: 'b.png' }]);
    expect(pickNewAttachments(undefined, incoming)).toEqual(incoming);
  });

  it('ignores attachments without an id', () => {
    expect(pickNewAttachments([], [{ filename: 'x.png' }])).toEqual([]);
  });
});

describe('mobile upload requests', () => {
  const response = (data: unknown) => ({ data: { data } });

  it('sends the token as a header, skips the login redirect, and posts multipart for uploads', async () => {
    const request = vi.fn().mockResolvedValue(response({}));
    const file = new File(['x'], 'photo.png', { type: 'image/png' });

    await uploadMobileFile({ request } as never, 'tok', file);

    const config = request.mock.calls[0][0];
    expect(config).toMatchObject({
      url: 'aiFiles:uploadBySession',
      method: 'post',
      headers: { [MOBILE_UPLOAD_TOKEN_HEADER]: 'tok' },
      skipAuth: true,
      skipNotify: true,
    });
    expect((config.data as FormData).get('file')).toBe(file);
  });

  it('checks a session anonymously', async () => {
    const request = vi.fn().mockResolvedValue(response({ expiresAt: 1, maxFiles: 10, uploaded: 0 }));
    await expect(checkMobileUploadSession({ request } as never, 'tok')).resolves.toEqual({
      expiresAt: 1,
      maxFiles: 10,
      uploaded: 0,
    });
    expect(request.mock.calls[0][0]).toMatchObject({
      headers: { [MOBILE_UPLOAD_TOKEN_HEADER]: 'tok' },
      skipAuth: true,
    });
  });

  it('normalizes polled files into done attachments with their storage source', async () => {
    const source = { dataSourceKey: 'main', collectionName: 'aiFiles' };
    const request = vi
      .fn()
      .mockResolvedValue(response({ expiresAt: 5, files: [{ id: 7, filename: 'p.png', meta: { source } }] }));

    const result = await getMobileUploadSession({ request } as never, 'tok');

    expect(result.expiresAt).toBe(5);
    expect(result.files).toEqual([expect.objectContaining({ id: 7, status: 'done', source })]);
  });

  it('fails fast when the response has no data', async () => {
    const request = vi.fn().mockResolvedValue({ data: {} });
    await expect(checkMobileUploadSession({ request } as never, 'tok')).rejects.toThrow(/did not contain data/);
  });
});
