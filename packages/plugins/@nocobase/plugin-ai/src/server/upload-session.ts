/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import crypto from 'node:crypto';
import type { Context, Next } from '@nocobase/actions';
import type { Cache } from '@nocobase/cache';
import type { Model } from '@nocobase/database';
import type { AttachmentModel } from '@nocobase/plugin-file-manager';
import { appendAIFileAttachmentSource } from './attachments';
import type PluginAIServer from './plugin';
import { name as namespace } from '../../package.json';

const CACHE_NAME = 'ai-file-upload-session';
const LOCK_KEY_PREFIX = 'ai-file-upload-session:';
const LOCK_TTL = 3000;

export const UPLOAD_SESSION_TTL = 5 * 60 * 1000;
export const UPLOAD_SESSION_MAX_FILES = 10;
// Rejected uploads (non-images, over the file limit) are stored and removed again, so attempts are capped separately.
export const UPLOAD_SESSION_MAX_ATTEMPTS = UPLOAD_SESSION_MAX_FILES * 3;
export const UPLOAD_SESSION_TOKEN_HEADER = 'X-AI-Upload-Token';

type FileId = string | number;

type UploadSession = {
  userId: FileId;
  fileIds: FileId[];
  attempts: number;
  expiresAt: number;
};

export type UploadSessionInfo = {
  token: string;
  expiresAt: number;
  maxFiles: number;
};

/**
 * Short-lived, user-bound upload sessions that let a phone (no login state) upload images on behalf of the user who
 * created the session on the desktop. A session only grants "upload", never "read": reading goes through the desktop's
 * own login state and is checked against `session.userId`.
 */
export class AIFileUploadSessionManager {
  private cachePromise?: Promise<Cache>;

  constructor(private readonly plugin: PluginAIServer) {}

  async create(userId: FileId): Promise<UploadSessionInfo> {
    const token = crypto.randomBytes(32).toString('hex');
    const session: UploadSession = { userId, fileIds: [], attempts: 0, expiresAt: Date.now() + UPLOAD_SESSION_TTL };
    await this.save(token, session);
    return { token, expiresAt: session.expiresAt, maxFiles: UPLOAD_SESSION_MAX_FILES };
  }

  async get(token: string): Promise<UploadSession | null> {
    if (!token) {
      return null;
    }
    const session = await (await this.getCache()).get<UploadSession>(token);
    if (!session || session.expiresAt <= Date.now()) {
      return null;
    }
    return session;
  }

  async getOwned(token: string, userId: FileId): Promise<UploadSession | null> {
    const session = await this.get(token);
    return session && String(session.userId) === String(userId) ? session : null;
  }

  /**
   * Counts one upload attempt. Returns false when the session is gone or has used up its attempts.
   */
  async reserveAttempt(token: string): Promise<boolean> {
    return this.plugin.app.lockManager.runExclusive(
      `${LOCK_KEY_PREFIX}${token}`,
      async () => {
        const session = await this.get(token);
        if (!session || session.attempts >= UPLOAD_SESSION_MAX_ATTEMPTS) {
          return false;
        }
        session.attempts += 1;
        await this.save(token, session);
        return true;
      },
      LOCK_TTL,
    );
  }

  /**
   * Returns false when the session is gone or already holds the maximum number of files.
   */
  async appendFile(token: string, fileId: FileId): Promise<boolean> {
    return this.plugin.app.lockManager.runExclusive(
      `${LOCK_KEY_PREFIX}${token}`,
      async () => {
        const session = await this.get(token);
        if (!session || session.fileIds.length >= UPLOAD_SESSION_MAX_FILES) {
          return false;
        }
        session.fileIds.push(fileId);
        await this.save(token, session);
        return true;
      },
      LOCK_TTL,
    );
  }

  async revoke(token: string): Promise<void> {
    await (await this.getCache()).del(token);
  }

  private async save(token: string, session: UploadSession) {
    const ttl = Math.max(session.expiresAt - Date.now(), 1);
    await (await this.getCache()).set(token, session, ttl);
  }

  private async getCache() {
    this.cachePromise ??= this.plugin.app.cacheManager.createCache({
      name: CACHE_NAME,
      store: this.plugin.app.options.cacheManager?.defaultStore ?? 'memory',
    });
    return this.cachePromise;
  }
}

function readToken(ctx: Context): string {
  return ctx.get(UPLOAD_SESSION_TOKEN_HEADER);
}

const MAGIC_HEAD_BYTES = 12;

// The declared mimetype comes from the client, so the anonymous channel verifies the stored bytes instead.
export function sniffImageMimetype(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }
  if (head.length >= 4 && head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return 'image/png';
  }
  if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'GIF8') {
    return 'image/gif';
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

async function readFileHead(plugin: PluginAIServer, record: Model): Promise<Buffer> {
  const { stream } = await plugin.fileManager.getFileStream(record.toJSON() as AttachmentModel);
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      length += buffer.length;
      if (length >= MAGIC_HEAD_BYTES) {
        break;
      }
    }
    return Buffer.concat(chunks);
  } finally {
    stream.destroy();
  }
}

/**
 * Must run before `auth`. It turns an `aiFiles:uploadBySession` request carrying a valid token into a regular
 * `aiFiles:create` request attributed to the session's user, so that file-manager's multipart handling, storage rules
 * and the `createdById` context field are reused as-is.
 */
export function createUploadBySessionMiddleware(plugin: PluginAIServer) {
  return async function uploadBySessionMiddleware(ctx: Context, next: Next) {
    const { resourceName, actionName } = ctx.action ?? {};
    if (resourceName !== 'aiFiles' || actionName !== 'uploadBySession') {
      return next();
    }

    const manager = plugin.uploadSessions;
    const token = readToken(ctx);
    const session = await manager.get(token);
    if (!session) {
      return ctx.throw(401, ctx.t('The upload session has expired or is invalid', { ns: namespace }));
    }
    if (session.fileIds.length >= UPLOAD_SESSION_MAX_FILES) {
      return ctx.throw(
        400,
        ctx.t('You can upload up to {{count}} attachments.', { ns: namespace, count: UPLOAD_SESSION_MAX_FILES }),
      );
    }

    if (!(await manager.reserveAttempt(token))) {
      return ctx.throw(429, ctx.t('Too many upload attempts, please scan the QR code again', { ns: namespace }));
    }

    const user = await ctx.db.getRepository('users').findOne({ filterByTk: session.userId });
    if (!user) {
      return ctx.throw(401, ctx.t('The upload session has expired or is invalid', { ns: namespace }));
    }

    ctx.skipAuthCheck = true;
    ctx.state.currentUser = user;
    ctx.action.actionName = 'create';

    await next();

    const record = ctx.body as Model | undefined;
    const fileId = record?.get('id') as FileId | undefined;
    if (fileId === undefined) {
      return;
    }
    // The file is already stored by file-manager at this point; remove it again when it must be rejected.
    let rejectReason: string | null = null;
    if (!sniffImageMimetype(await readFileHead(plugin, record))) {
      rejectReason = ctx.t('Only image files can be uploaded', { ns: namespace });
    } else if (!(await manager.appendFile(token, fileId))) {
      rejectReason = ctx.t('You can upload up to {{count}} attachments.', {
        ns: namespace,
        count: UPLOAD_SESSION_MAX_FILES,
      });
    }
    if (rejectReason) {
      await ctx.db.getRepository('aiFiles').destroy({ filterByTk: fileId });
      ctx.body = undefined;
      ctx.throw(400, rejectReason);
    }
  };
}

export function createUploadSessionActions(plugin: PluginAIServer) {
  return {
    createUploadSession: async (ctx: Context, next: Next) => {
      ctx.body = await plugin.uploadSessions.create(ctx.state.currentUser.id);
      await next();
    },

    // Called by the phone page (public) before the user picks photos, so an expired QR code is reported up front.
    checkUploadSession: async (ctx: Context, next: Next) => {
      const session = await plugin.uploadSessions.get(readToken(ctx));
      if (!session) {
        return ctx.throw(401, ctx.t('The upload session has expired or is invalid', { ns: namespace }));
      }
      ctx.body = {
        expiresAt: session.expiresAt,
        maxFiles: UPLOAD_SESSION_MAX_FILES,
        uploaded: session.fileIds.length,
      };
      await next();
    },

    // Called by the desktop (loggedIn) while the QR dialog is open; only the session's owner can read it.
    getUploadSession: async (ctx: Context, next: Next) => {
      const token = ctx.action.params.token;
      const session =
        typeof token === 'string' ? await plugin.uploadSessions.getOwned(token, ctx.state.currentUser.id) : null;
      if (!session) {
        return ctx.throw(404, ctx.t('The upload session has expired or is invalid', { ns: namespace }));
      }
      const files = session.fileIds.length
        ? await ctx.db.getRepository('aiFiles').find({
            filter: { id: { $in: session.fileIds }, createdById: ctx.state.currentUser.id },
            sort: ['id'],
          })
        : [];
      // Same shape as an `aiFiles:create` response, which the chat box relies on to resolve the attachment source.
      files.forEach((file) => appendAIFileAttachmentSource(file));
      ctx.body = { expiresAt: session.expiresAt, files };
      await next();
    },

    revokeUploadSession: async (ctx: Context, next: Next) => {
      const token = ctx.action.params.token;
      if (typeof token === 'string' && (await plugin.uploadSessions.getOwned(token, ctx.state.currentUser.id))) {
        await plugin.uploadSessions.revoke(token);
      }
      ctx.body = { ok: true };
      await next();
    },
  };
}
