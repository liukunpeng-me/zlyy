/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { APIClient } from '@nocobase/client-v2';
import type { Attachment } from '../types';
import { normalizeAIFileUploadAttachment } from './utils';

export const MOBILE_UPLOAD_ROUTE_NAME = 'ai-mobile-upload';
export const MOBILE_UPLOAD_ROUTE_PATH = '/ai-mobile-upload/:token';
export const MOBILE_UPLOAD_TOKEN_HEADER = 'X-AI-Upload-Token';
export const MOBILE_UPLOAD_POLL_INTERVAL = 2000;

export type MobileUploadSession = {
  token: string;
  expiresAt: number;
  maxFiles: number;
};

export type MobileUploadSessionStatus = {
  expiresAt: number;
  maxFiles: number;
  uploaded: number;
};

type ApiClientLike = Pick<APIClient, 'request'>;

type MobileUploadAppLike = {
  router?: {
    getBasename?: () => string | undefined;
  };
  getPublicPath?: () => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readData(response: unknown): Record<string, unknown> {
  const body = isRecord(response) ? response.data : undefined;
  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data)) {
    throw new Error('AI mobile upload response did not contain data.');
  }
  return data;
}

function joinPath(base: string | undefined, pathname: string) {
  const normalizedBase = (base ?? '').replace(/\/+$/, '');
  return `${normalizedBase}/${pathname.replace(/^\/+/, '')}`;
}

export function getMobileUploadUrl(
  app: MobileUploadAppLike | undefined,
  token: string,
  origin = window.location.origin,
) {
  const base = app?.router?.getBasename?.() ?? app?.getPublicPath?.();
  const pathname = joinPath(base, MOBILE_UPLOAD_ROUTE_PATH.replace(':token', encodeURIComponent(token)));
  return new URL(pathname, origin).toString();
}

export async function createMobileUploadSession(apiClient: ApiClientLike): Promise<MobileUploadSession> {
  const response = await apiClient.request({ url: 'aiFiles:createUploadSession', method: 'post' });
  return readData(response) as unknown as MobileUploadSession;
}

export async function getMobileUploadSession(
  apiClient: ApiClientLike,
  token: string,
  signal?: AbortSignal,
): Promise<{ expiresAt: number; files: Attachment[] }> {
  const response = await apiClient.request({
    url: 'aiFiles:getUploadSession',
    method: 'get',
    params: { token },
    signal,
    // The dialog polls in the background; an expired session is handled in the UI instead of a global toast.
    skipNotify: true,
  });
  const data = readData(response);
  const files = Array.isArray(data.files) ? (data.files as Attachment[]) : [];
  return {
    expiresAt: Number(data.expiresAt),
    files: files.map((file) => normalizeAIFileUploadAttachment(file, 'done')),
  };
}

export async function revokeMobileUploadSession(apiClient: ApiClientLike, token: string): Promise<void> {
  await apiClient.request({
    url: 'aiFiles:revokeUploadSession',
    method: 'post',
    params: { token },
    skipNotify: true,
  });
}

export async function checkMobileUploadSession(
  apiClient: ApiClientLike,
  token: string,
): Promise<MobileUploadSessionStatus> {
  const response = await apiClient.request({
    url: 'aiFiles:checkUploadSession',
    method: 'get',
    headers: { [MOBILE_UPLOAD_TOKEN_HEADER]: token },
    skipNotify: true,
    skipAuth: true,
  });
  return readData(response) as unknown as MobileUploadSessionStatus;
}

export async function uploadMobileFile(apiClient: ApiClientLike, token: string, file: File): Promise<void> {
  const formData = new FormData();
  formData.append('file', file);
  await apiClient.request({
    url: 'aiFiles:uploadBySession',
    method: 'post',
    data: formData,
    headers: { [MOBILE_UPLOAD_TOKEN_HEADER]: token },
    skipNotify: true,
    skipAuth: true,
  });
}

/**
 * Attachments that arrived from the phone and are not in the chat box yet, matched by id.
 */
export function pickNewAttachments(existing: Attachment[] | undefined, incoming: Attachment[]): Attachment[] {
  const knownIds = new Set((existing ?? []).map((attachment) => attachment.id).filter((id) => id !== undefined));
  return incoming.filter((attachment) => attachment.id !== undefined && !knownIds.has(attachment.id));
}
