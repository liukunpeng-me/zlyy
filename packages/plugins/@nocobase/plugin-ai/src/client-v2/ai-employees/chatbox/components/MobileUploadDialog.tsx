/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Flex, Modal, QRCode, Typography } from 'antd';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../../../locale';
import type { Attachment } from '../../types';
import {
  createMobileUploadSession,
  getMobileUploadSession,
  getMobileUploadUrl,
  MOBILE_UPLOAD_POLL_INTERVAL,
  pickNewAttachments,
  revokeMobileUploadSession,
  type MobileUploadSession,
} from '../mobile-upload';

type MobileUploadDialogProps = {
  open: boolean;
  /** Attachments already in the chat box; the dialog only reports ones it has not seen. */
  attachments: Attachment[] | undefined;
  onClose: () => void;
  onAttachments: (attachments: Attachment[]) => void;
};

type DialogState = 'loading' | 'ready' | 'expired' | 'error';

export const MobileUploadDialog: React.FC<MobileUploadDialogProps> = ({
  open,
  attachments,
  onClose,
  onAttachments,
}) => {
  const t = useT();
  const app = useApp();
  const [state, setState] = useState<DialogState>('loading');
  const [session, setSession] = useState<MobileUploadSession | null>(null);
  const [receivedCount, setReceivedCount] = useState(0);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const onAttachmentsRef = useRef(onAttachments);
  onAttachmentsRef.current = onAttachments;
  // Ids already handed to the chat box by this dialog; the chat box list may lag behind a poll or be edited by the user.
  const deliveredIdsRef = useRef(new Set<string | number>());

  const start = useCallback(async () => {
    setState('loading');
    setSession(null);
    setReceivedCount(0);
    deliveredIdsRef.current = new Set();
    try {
      setSession(await createMobileUploadSession(app.apiClient));
      setState('ready');
    } catch (error) {
      setState('error');
      throw error;
    }
  }, [app]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    start().catch(() => undefined);
    return undefined;
  }, [open, start]);

  const token = session?.token;
  useEffect(() => {
    if (!open || !token || state !== 'ready') {
      return undefined;
    }
    const controller = new AbortController();
    const poll = async () => {
      try {
        const result = await getMobileUploadSession(app.apiClient, token, controller.signal);
        const fresh = pickNewAttachments(attachmentsRef.current, result.files).filter(
          (file) => file.id !== undefined && !deliveredIdsRef.current.has(file.id),
        );
        if (fresh.length) {
          fresh.forEach((file) => file.id !== undefined && deliveredIdsRef.current.add(file.id));
          onAttachmentsRef.current(fresh);
        }
        setReceivedCount(result.files.length);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        // 401/404 mean the session expired or was revoked; anything else is retried on the next tick.
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status === 401 || status === 404) {
          setState('expired');
        }
      }
    };
    const timer = window.setInterval(poll, MOBILE_UPLOAD_POLL_INTERVAL);
    poll().catch(() => undefined);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [app, open, state, token]);

  useEffect(() => {
    if (!session || state !== 'ready') {
      return undefined;
    }
    const remaining = session.expiresAt - Date.now();
    const timer = window.setTimeout(() => setState('expired'), Math.max(remaining, 0));
    return () => window.clearTimeout(timer);
  }, [session, state]);

  // Closing the dialog ends the session so a leaked QR code stops working immediately.
  useEffect(() => {
    if (open || !token) {
      return undefined;
    }
    revokeMobileUploadSession(app.apiClient, token).catch(() => undefined);
    return undefined;
  }, [app, open, token]);

  const url = session ? getMobileUploadUrl(app, session.token) : '';

  return (
    <Modal
      open={open}
      title={t('Upload from phone')}
      footer={null}
      onCancel={onClose}
      destroyOnClose
      width={360}
      centered
    >
      <Flex vertical align="center" gap={12} role="region" aria-live="polite">
        <QRCode
          value={url || '-'}
          size={200}
          status={state === 'ready' ? 'active' : state === 'loading' ? 'loading' : 'expired'}
          onRefresh={() => {
            start().catch(() => undefined);
          }}
          aria-label={t('QR code for uploading images from your phone')}
        />
        <Typography.Text type="secondary" style={{ textAlign: 'center' }}>
          {state === 'error'
            ? t('Failed to create the QR code')
            : t('Scan with your phone to take a photo or choose images from the album')}
        </Typography.Text>
        {state === 'ready' ? (
          <Typography.Text>{t('Received {{count}} image(s)', { count: receivedCount })}</Typography.Text>
        ) : null}
        {state === 'error' ? (
          <Button
            onClick={() => {
              start().catch(() => undefined);
            }}
          >
            {t('Retry')}
          </Button>
        ) : null}
        <Button type="primary" onClick={onClose}>
          {t('Done')}
        </Button>
      </Flex>
    </Modal>
  );
};
