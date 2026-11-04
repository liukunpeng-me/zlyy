/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createMockServer, MockServer } from '@nocobase/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  sniffImageMimetype,
  UPLOAD_SESSION_MAX_ATTEMPTS,
  UPLOAD_SESSION_MAX_FILES,
  UPLOAD_SESSION_TOKEN_HEADER,
} from '../upload-session';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

describe('sniffImageMimetype', () => {
  it('recognizes common image formats from magic bytes', () => {
    expect(sniffImageMimetype(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMimetype(PNG)).toBe('image/png');
    expect(sniffImageMimetype(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImageMimetype(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'))).toBe('image/webp');
  });

  it('rejects non-image and active content', () => {
    expect(sniffImageMimetype(HTML)).toBeNull();
    expect(sniffImageMimetype(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageMimetype(Buffer.alloc(0))).toBeNull();
  });
});

describe('aiFiles upload session', () => {
  let app: MockServer;
  let owner: { id: number };
  let other: { id: number };

  beforeAll(async () => {
    app = await createMockServer({
      registerActions: true,
      acl: true,
      plugins: ['nocobase'],
    });
    await app.pm.enable('ai');
    const users = app.db.getRepository('users');
    owner = await users.create({
      values: { nickname: 'Upload owner', username: 'ai-upload-owner', email: 'ai-upload-owner@example.com' },
    });
    other = await users.create({
      values: { nickname: 'Upload other', username: 'ai-upload-other', email: 'ai-upload-other@example.com' },
    });
  });

  afterAll(async () => {
    await app.db.clean({ drop: true });
    await app.destroy();
  });

  const createSession = async () => {
    const ownerAgent = await app.agent().login(owner.id);
    const response = await ownerAgent.resource('aiFiles').createUploadSession();
    expect(response.statusCode).toBe(200);
    return { ownerAgent, token: response.body.data.token as string };
  };

  const phoneUpload = (token: string | undefined, content: Buffer, filename: string, contentType: string) => {
    const request = app.agent().post('/aiFiles:uploadBySession');
    if (token !== undefined) {
      request.set(UPLOAD_SESSION_TOKEN_HEADER, token);
    }
    return request.attach('file', content, { filename, contentType });
  };

  it('requires a login to create a session', async () => {
    const response = await app.agent().resource('aiFiles').createUploadSession();
    expect(response.statusCode).toBe(401);
  });

  it('lets an anonymous phone upload an image that belongs to the session owner', async () => {
    const { ownerAgent, token } = await createSession();

    const check = await app.agent().get('/aiFiles:checkUploadSession').set(UPLOAD_SESSION_TOKEN_HEADER, token);
    expect(check.statusCode).toBe(200);
    expect(check.body.data).toMatchObject({ maxFiles: UPLOAD_SESSION_MAX_FILES, uploaded: 0 });

    const upload = await phoneUpload(token, PNG, 'photo.png', 'image/png');
    expect(upload.statusCode).toBe(200);
    expect(upload.body.data.createdById).toBe(owner.id);

    const polled = await ownerAgent.resource('aiFiles').getUploadSession({ token });
    expect(polled.statusCode).toBe(200);
    expect(polled.body.data.files.map((file: { id: number }) => file.id)).toEqual([upload.body.data.id]);
    expect(polled.body.data.files[0].meta.source).toMatchObject({ collectionName: 'aiFiles' });
  });

  it('rejects uploads without a token, with a wrong token, and does not fall back to a login', async () => {
    const missing = await phoneUpload(undefined, PNG, 'photo.png', 'image/png');
    expect(missing.statusCode).toBe(401);

    const wrong = await phoneUpload('0'.repeat(64), PNG, 'photo.png', 'image/png');
    expect(wrong.statusCode).toBe(401);

    // A plain anonymous call to the action name must not be treated as an authenticated upload.
    const anonymous = await app.agent().post('/aiFiles:create').attach('file', PNG, 'photo.png');
    expect(anonymous.statusCode).toBe(401);
  });

  it('rejects non-image content even when the client declares an image mimetype, and stores nothing', async () => {
    const { ownerAgent, token } = await createSession();
    const before = await app.db.getRepository('aiFiles').count();

    const upload = await phoneUpload(token, HTML, 'photo.png', 'image/png');
    expect(upload.statusCode).toBe(400);
    expect(await app.db.getRepository('aiFiles').count()).toBe(before);

    const polled = await ownerAgent.resource('aiFiles').getUploadSession({ token });
    expect(polled.body.data.files).toEqual([]);
  });

  it('caps the number of files per session', async () => {
    const { token } = await createSession();
    for (let index = 0; index < UPLOAD_SESSION_MAX_FILES; index += 1) {
      const upload = await phoneUpload(token, PNG, `photo-${index}.png`, 'image/png');
      expect(upload.statusCode).toBe(200);
    }
    const overflow = await phoneUpload(token, PNG, 'photo-over.png', 'image/png');
    expect(overflow.statusCode).toBe(400);
  });

  it('caps the number of attempts per session, including rejected ones', async () => {
    const { token } = await createSession();
    for (let index = 0; index < UPLOAD_SESSION_MAX_ATTEMPTS; index += 1) {
      const upload = await phoneUpload(token, HTML, 'photo.png', 'image/png');
      expect(upload.statusCode).toBe(400);
    }
    const blocked = await phoneUpload(token, PNG, 'photo.png', 'image/png');
    expect(blocked.statusCode).toBe(429);
  });

  it('only exposes a session to the user who created it', async () => {
    const { token } = await createSession();
    await phoneUpload(token, PNG, 'photo.png', 'image/png');

    const otherAgent = await app.agent().login(other.id);
    const polled = await otherAgent.resource('aiFiles').getUploadSession({ token });
    expect(polled.statusCode).toBe(404);

    const revoked = await otherAgent.resource('aiFiles').revokeUploadSession({ token });
    expect(revoked.statusCode).toBe(200);
    const stillThere = await app.agent().get('/aiFiles:checkUploadSession').set(UPLOAD_SESSION_TOKEN_HEADER, token);
    expect(stillThere.statusCode).toBe(200);
  });

  it('stops accepting uploads once the owner revokes the session', async () => {
    const { ownerAgent, token } = await createSession();
    const revoked = await ownerAgent.resource('aiFiles').revokeUploadSession({ token });
    expect(revoked.statusCode).toBe(200);

    const upload = await phoneUpload(token, PNG, 'photo.png', 'image/png');
    expect(upload.statusCode).toBe(401);
    const check = await app.agent().get('/aiFiles:checkUploadSession').set(UPLOAD_SESSION_TOKEN_HEADER, token);
    expect(check.statusCode).toBe(401);
  });
});
