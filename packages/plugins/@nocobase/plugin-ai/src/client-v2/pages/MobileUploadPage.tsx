/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Flex, List, Result, Spin, Typography } from 'antd';
import {
  CameraOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  PictureOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useParams } from 'react-router-dom';
import { useT } from '../locale';
import {
  checkMobileUploadSession,
  uploadMobileFile,
  type MobileUploadSessionStatus,
} from '../ai-employees/chatbox/mobile-upload';

type UploadItem = {
  key: string;
  name: string;
  status: 'uploading' | 'done' | 'error';
  error?: string;
};

type PageState = { type: 'checking' } | { type: 'invalid' } | { type: 'ready'; session: MobileUploadSessionStatus };

function readErrorMessage(error: unknown, fallback: string) {
  const errors = (error as { response?: { data?: { errors?: { message?: string }[] } } })?.response?.data?.errors;
  return errors?.[0]?.message || fallback;
}

/**
 * Anonymous page opened from the desktop QR code. The token in the URL is the only credential: it can upload images
 * to one user's chat box and nothing else.
 */
export const MobileUploadPage: React.FC = () => {
  const t = useT();
  const app = useApp();
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<PageState>({ type: 'checking' });
  const [items, setItems] = useState<UploadItem[]>([]);
  const albumInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const sequenceRef = useRef(0);

  useEffect(() => {
    if (!token) {
      setState({ type: 'invalid' });
      return undefined;
    }
    let cancelled = false;
    checkMobileUploadSession(app.apiClient, token)
      .then((session) => !cancelled && setState({ type: 'ready', session }))
      .catch(() => !cancelled && setState({ type: 'invalid' }));
    return () => {
      cancelled = true;
    };
  }, [app, token]);

  const updateItem = (key: string, patch: Partial<UploadItem>) =>
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  const uploadFile = async (file: File) => {
    sequenceRef.current += 1;
    const key = `${sequenceRef.current}-${file.name}`;
    setItems((prev) => [...prev, { key, name: file.name, status: 'uploading' }]);
    try {
      await uploadMobileFile(app.apiClient, token, file);
      updateItem(key, { status: 'done' });
    } catch (error) {
      updateItem(key, { status: 'error', error: readErrorMessage(error, t('Upload failed')) });
    }
  };

  const handleSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // Reset so selecting the same photo again still fires `change`.
    event.target.value = '';
    for (const file of files) {
      await uploadFile(file);
    }
  };

  if (state.type === 'checking') {
    return (
      <Flex justify="center" align="center" style={{ minHeight: '100vh' }}>
        <Spin />
      </Flex>
    );
  }

  if (state.type === 'invalid') {
    return (
      <Result
        status="warning"
        title={t('This QR code has expired')}
        subTitle={t('Please go back to the computer and scan a new QR code')}
      />
    );
  }

  const uploading = items.some((item) => item.status === 'uploading');
  const doneCount = items.filter((item) => item.status === 'done').length;

  return (
    <Flex vertical gap={16} style={{ padding: 16, maxWidth: 480, margin: '0 auto' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t('Upload images to AI chat')}
      </Typography.Title>
      <Typography.Text type="secondary">
        {t('Images are sent to the chat box on your computer. You can upload up to {{count}} images.', {
          count: state.session.maxFiles,
        })}
      </Typography.Text>
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={handleSelected}
        aria-label={t('Take a photo')}
      />
      <input
        ref={albumInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={handleSelected}
        aria-label={t('Choose from album')}
      />
      <Flex gap={12}>
        <Button
          type="primary"
          size="large"
          block
          icon={<CameraOutlined />}
          disabled={uploading}
          onClick={() => cameraInputRef.current?.click()}
        >
          {t('Take a photo')}
        </Button>
        <Button
          size="large"
          block
          icon={<PictureOutlined />}
          disabled={uploading}
          onClick={() => albumInputRef.current?.click()}
        >
          {t('Choose from album')}
        </Button>
      </Flex>
      {doneCount ? (
        <Alert type="success" showIcon message={t('Uploaded {{count}} image(s)', { count: doneCount })} />
      ) : null}
      <List
        dataSource={items}
        renderItem={(item) => (
          <List.Item>
            <Flex justify="space-between" align="center" gap={8} style={{ width: '100%' }}>
              <Typography.Text ellipsis style={{ flex: 1 }}>
                {item.name}
              </Typography.Text>
              {item.status === 'uploading' ? <LoadingOutlined aria-label={t('Uploading')} /> : null}
              {item.status === 'done' ? (
                <CheckCircleFilled style={{ color: '#52c41a' }} aria-label={t('Uploaded')} />
              ) : null}
              {item.status === 'error' ? (
                <Typography.Text type="danger">
                  <CloseCircleFilled aria-label={t('Upload failed')} /> {item.error}
                </Typography.Text>
              ) : null}
            </Flex>
          </List.Item>
        )}
      />
    </Flex>
  );
};

export default MobileUploadPage;
