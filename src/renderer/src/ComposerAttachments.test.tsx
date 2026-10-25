// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ComposerAttachments } from './ComposerAttachments'
import type { Attachment } from '@shared/types'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('keeps controls outside previews and targets original attachment indices after grouping images and files', async () => {
  const attachments: Attachment[] = [
    { kind: 'file', name: 'first.md', text: 'first' },
    { kind: 'image', name: 'wide.png', mimeType: 'image/png', data: 'wide' },
    { kind: 'file', name: 'second.md', text: 'second' },
    { kind: 'image', name: 'tall.png', mimeType: 'image/png', data: 'tall' }
  ]
  const onRemove = vi.fn()
  const onEditImage = vi.fn()
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  try {
    await act(async () => root.render(<ComposerAttachments attachments={attachments} canEditImage={() => true} onEditImage={onEditImage} onRemove={onRemove} />))
    expect(el.querySelectorAll('.attachment-strip li')).toHaveLength(2)
    expect(el.querySelectorAll('.attachment-files li')).toHaveLength(2)
    expect(el.querySelector('.capture-preview .capture-edit')).toBeNull()
    expect(el.querySelector('.capture-preview .attachment-remove')).toBeNull()
    act(() => button('Annotate tall.png').click())
    expect(onEditImage).toHaveBeenCalledWith(attachments[3], 3)
    act(() => button('Remove second.md').click())
    expect(onRemove).toHaveBeenCalledWith(2)
    act(() => button('Preview wide.png').click())
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Preview wide.png')
    act(() => document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(button('Preview wide.png'))
  } finally { act(() => root.unmount()); el.remove() }
})
