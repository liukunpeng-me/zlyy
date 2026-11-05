/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { css } from '@emotion/css';
import { sanitizeRichTextHtml } from '@nocobase/utils/client';
import { Image } from 'antd';
import React, { useState } from 'react';
import { useParseMarkdown } from '../internal/components/Markdown/util';

const markdownTipClass = css({
  // 覆盖外层 FormItem/Tooltip 设置的 pre-line / pre-wrap，避免 Markdown 渲染出的块级元素之间多出空行
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  'p, ul, ol, blockquote': { margin: 0 },
  img: { maxWidth: '100%', height: 'auto', cursor: 'zoom-in' },
});

/**
 * 字段 Tooltip / Description 的 Markdown 渲染：支持换行与图片 `![说明](url)`。
 * 渲染结果必须经过 sanitizeRichTextHtml 白名单过滤，Markdown 源文本由配置人员输入，不可信。
 */
export const MarkdownTip: React.FC<{ value: string }> = ({ value }) => {
  const { html } = useParseMarkdown(value);
  const [previewSrc, setPreviewSrc] = useState<string>();

  // html 由 sanitizeRichTextHtml 生成并通过 dangerouslySetInnerHTML 注入，用事件委托捕获其中 <img> 的点击
  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof HTMLImageElement && target.src) {
      setPreviewSrc(target.src);
    }
  };

  return (
    <>
      <div
        className={markdownTipClass}
        onClick={handleClick}
        dangerouslySetInnerHTML={{ __html: sanitizeRichTextHtml(html || '') }}
      />
      {previewSrc && (
        <Image.PreviewGroup
          items={[previewSrc]}
          preview={{
            visible: true,
            onVisibleChange: (visible) => {
              if (!visible) {
                setPreviewSrc(undefined);
              }
            },
          }}
        />
      )}
    </>
  );
};

/**
 * 字符串类型的 tooltip / extra 转成 MarkdownTip 节点，非字符串（已是 ReactNode）原样返回。
 * model 内存储的值仍是字符串，只在渲染点转换。
 */
export function toMarkdownTip<T>(value: T): T | React.ReactElement {
  return typeof value === 'string' && value ? <MarkdownTip value={value} /> : value;
}

export function withMarkdownTips<T extends { tooltip?: unknown; extra?: unknown }>(props: T): T {
  return { ...props, tooltip: toMarkdownTip(props.tooltip), extra: toMarkdownTip(props.extra) };
}
