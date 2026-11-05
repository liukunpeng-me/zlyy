/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { render, screen, userEvent, waitFor } from '@nocobase/test/client';
import { FormItem } from '@nocobase/flow-engine';
import { Form } from 'antd';
import React from 'react';
import { MarkdownTip, toMarkdownTip, withMarkdownTips } from '../MarkdownTip';

describe('MarkdownTip', () => {
  it('renders a markdown image', async () => {
    const { container } = render(<MarkdownTip value={'![format](https://example.com/format.png)'} />);

    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://example.com/format.png');
    expect(container.querySelector('img')).toHaveAttribute('alt', 'format');
  });

  it('renders line breaks as <br>', async () => {
    const { container } = render(<MarkdownTip value={'line one\nline two'} />);

    await waitFor(() => expect(container.querySelector('br')).not.toBeNull());
    expect(container).toHaveTextContent('line one');
    expect(container).toHaveTextContent('line two');
  });

  it('removes script, event handlers and javascript: links', async () => {
    const { container } = render(
      <MarkdownTip
        value={[
          'safe',
          '<script>alert(1)</script>',
          '<img src="https://example.com/a.png" onerror="alert(1)">',
          '<iframe src="https://example.com"></iframe>',
          '[click](javascript:alert(1))',
          '<a href="javascript:alert(1)">raw</a>',
        ].join('\n\n')}
      />,
    );

    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(container).toHaveTextContent('safe');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('img')).not.toHaveAttribute('onerror');
    container.querySelectorAll('a').forEach((a) => {
      expect(a.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
    });
  });

  it('drops images whose src uses a non http(s)/data-image scheme', async () => {
    const { container } = render(<MarkdownTip value={'![x](javascript:alert(1))\n\ntext after'} />);

    await waitFor(() => expect(container).toHaveTextContent('text after'));
    expect(container.querySelector('img[src^="javascript:"]')).toBeNull();
  });

  it('opens a zoomed preview of the clicked image and closes it with the close button', async () => {
    const { container } = render(<MarkdownTip value={'![format](https://example.com/format.png)'} />);

    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(document.querySelector('.ant-image-preview-img')).toBeNull();

    await userEvent.click(container.querySelector('img') as HTMLElement);

    await waitFor(() => expect(document.querySelector('.ant-image-preview-img')).not.toBeNull());
    expect(document.querySelector('.ant-image-preview-img')).toHaveAttribute('src', 'https://example.com/format.png');

    await userEvent.click(document.querySelector('.ant-image-preview-close') as HTMLElement);

    await waitFor(() => expect(document.querySelector('.ant-image-preview-root')).toBeNull());
  });

  it('does not open a preview when non-image text is clicked', async () => {
    const { container } = render(<MarkdownTip value={'plain text ![x](https://example.com/x.png)'} />);

    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    await userEvent.click(container.querySelector('p') as HTMLElement);

    expect(document.querySelector('.ant-image-preview-img')).toBeNull();
  });

  it('keeps plain text readable', async () => {
    render(<MarkdownTip value={'just a plain description'} />);

    expect(await screen.findByText('just a plain description')).toBeInTheDocument();
  });
});

describe('MarkdownTip inside a real FormItem tooltip', () => {
  it('keeps the zoomed preview open after the pointer leaves the tooltip', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = withMarkdownTips({ label: 'Name', tooltip: '![f](https://example.com/f.png)' });
    const { container } = render(
      <Form>
        <FormItem {...props}>
          <span>value</span>
        </FormItem>
      </Form>,
    );

    await user.hover(container.querySelector('.anticon-question-circle') as HTMLElement);
    await waitFor(() => expect(document.querySelector('.ant-tooltip img')).not.toBeNull());
    await user.click(document.querySelector('.ant-tooltip img') as HTMLElement);
    await waitFor(() => expect(document.querySelector('.ant-image-preview-img')).not.toBeNull());

    await user.unhover(document.querySelector('.ant-tooltip') as HTMLElement);
    await user.hover(document.body);
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(document.querySelector('.ant-image-preview-img')).not.toBeNull();
  });
});

describe('toMarkdownTip / withMarkdownTips', () => {
  it('converts a non-empty string into a MarkdownTip element', () => {
    const node = toMarkdownTip('hello');

    expect(React.isValidElement(node)).toBe(true);
    expect((node as React.ReactElement).type).toBe(MarkdownTip);
  });

  it('passes empty, nullish and ReactNode values through unchanged', () => {
    const element = <b>already a node</b>;

    expect(toMarkdownTip('')).toBe('');
    expect(toMarkdownTip(undefined)).toBeUndefined();
    expect(toMarkdownTip(element)).toBe(element);
  });

  it('only rewrites tooltip and extra, other props are untouched', () => {
    const onChange = vi.fn();
    const result = withMarkdownTips({ tooltip: 'tip', extra: 'desc', label: 'Name', name: 'a', onChange });

    expect(React.isValidElement(result.tooltip)).toBe(true);
    expect(React.isValidElement(result.extra)).toBe(true);
    expect(result.label).toBe('Name');
    expect(result.name).toBe('a');
    expect(result.onChange).toBe(onChange);
  });
});
