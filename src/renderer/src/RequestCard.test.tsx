// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlossApi } from '@shared/ipc'
import { questionFields, type UserRequest } from '@shared/requests'
import { RequestCard } from './RequestCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
})

function mount(request: UserRequest, answer = vi.fn(async () => {})): typeof answer {
  window.gloss = { requests: { answer } } as unknown as GlossApi
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  act(() => root!.render(<RequestCard request={request} />))
  return answer
}

async function click(el: Element | null): Promise<void> {
  await act(async () => (el as HTMLElement).click())
}

const base = { id: 'r1', sessionId: 's1', threadId: null, createdAt: 1 }

describe('approval', () => {
  it("shows what will run and answers with the agent's option", async () => {
    const answer = mount({
      ...base,
      kind: 'permission',
      title: 'Run the tests',
      toolCallId: 't1',
      toolKind: 'execute',
      command: 'npm test',
      options: [
        { id: 'allow', name: 'Allow', kind: 'allow_once' },
        { id: 'always', name: 'Always allow', kind: 'allow_always' },
        { id: 'deny', name: 'Reject', kind: 'reject_once' }
      ]
    })
    expect(document.querySelector('.request-title')?.textContent).toBe('Approve? Run the tests')
    expect(document.querySelector('.request-command')?.textContent).toBe('npm test')
    const buttons = [...document.querySelectorAll('.request-actions button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['1Allow', '2Always allow', '3Reject'])
    expect(buttons[0].classList.contains('primary')).toBe(true)
    expect(buttons[1].getAttribute('title')).toMatch(/remember/)
    await click(buttons[2])
    expect(answer).toHaveBeenCalledWith('s1', 'r1', { kind: 'permission', optionId: 'deny' })
  })

  it('shows the error when the answer is refused', async () => {
    mount(
      { ...base, kind: 'permission', title: 'Edit', toolCallId: 't', options: [{ id: 'a', name: 'Allow', kind: 'allow_once' }] },
      vi.fn(async () => {
        throw new Error('The agent is no longer waiting for this.')
      })
    )
    await click(document.querySelector('.request-actions button'))
    expect(document.querySelector('.request-error')?.textContent).toBe('The agent is no longer waiting for this.')
  })
})

describe('question', () => {
  // The Claude adapter's AskUserQuestion form: a choice with its "Other" box, and a multi-select.
  const fields = questionFields({
    type: 'object',
    properties: {
      question_0: { type: 'string', title: 'Database', oneOf: [{ const: 'Postgres', title: 'Postgres', description: 'Relational' }, { const: 'SQLite', title: 'SQLite' }] },
      question_0_custom: { type: 'string', title: 'Other', description: 'Type your own answer' },
      question_1: { type: 'array', title: 'Extras', items: { anyOf: [{ const: 'Cache', title: 'Cache' }, { const: 'Search', title: 'Search' }] } }
    }
  })
  const question: UserRequest = { ...base, kind: 'question', message: 'Which **database**?', fields }

  it('builds the form and sends the picks', async () => {
    const answer = mount(question)
    expect(document.querySelector('.request-message strong')?.textContent).toBe('database')
    // The "Other" box sits inside the choice it belongs to.
    const groups = [...document.querySelectorAll('.request-field')]
    expect(groups).toHaveLength(2)
    expect(groups[0].querySelector('.request-option.other input')?.getAttribute('placeholder')).toBe('Type your own answer')
    const radios = groups[0].querySelectorAll<HTMLInputElement>('input[type="radio"]')
    await click(radios[1])
    const boxes = groups[1].querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    await click(boxes[0])
    await click(boxes[1])
    await click(document.querySelector('button[type="submit"]'))
    expect(answer).toHaveBeenCalledWith('s1', 'r1', {
      kind: 'question',
      action: 'accept',
      content: { question_0: 'SQLite', question_1: ['Cache', 'Search'] }
    })
  })

  it('unpicks an optional single choice, and declines or cancels', async () => {
    const answer = mount(question)
    const radio = document.querySelectorAll<HTMLInputElement>('input[type="radio"]')[0]
    await click(radio)
    expect(radio.checked).toBe(true)
    await click(radio)
    expect(radio.checked).toBe(false)
    const [, decline, cancel] = document.querySelectorAll('.request-actions button')
    await click(decline)
    expect(answer).toHaveBeenLastCalledWith('s1', 'r1', { kind: 'question', action: 'decline' })
    await click(cancel)
    expect(answer).toHaveBeenLastCalledWith('s1', 'r1', { kind: 'question', action: 'cancel' })
  })

  it("can't be submitted until required fields are answered", async () => {
    const required = questionFields({ type: 'object', properties: { name: { type: 'string', title: 'Name' } }, required: ['name'] })
    const answer = mount({ ...base, kind: 'question', message: 'Who?', fields: required })
    const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submit.disabled).toBe(true)
    expect(submit.title).toBe('Name needs an answer.')
    const input = document.querySelector<HTMLInputElement>('.request-text')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Ada')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(submit.disabled).toBe(false)
    await click(submit)
    expect(answer).toHaveBeenCalledWith('s1', 'r1', { kind: 'question', action: 'accept', content: { name: 'Ada' } })
  })
})

describe('keyboard', () => {
  function key(target: Element | null, init: KeyboardEventInit): void {
    act(() => {
      ;(target as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
    })
  }
  const options = [
    { id: 'allow', name: 'Yes', kind: 'allow_once' },
    { id: 'always', name: 'Yes, always', kind: 'allow_always' },
    { id: 'deny', name: 'No', kind: 'reject_once' }
  ]
  const approval: UserRequest = { ...base, kind: 'permission', title: 'Edit', toolCallId: 't', options }

  it('focuses a new card and answers an approval with number keys, Enter and Esc', () => {
    const answer = mount(approval)
    const card = document.querySelector('.request')!
    expect(document.activeElement).toBe(card)
    key(card, { key: '2' })
    expect(answer).toHaveBeenLastCalledWith('s1', 'r1', { kind: 'permission', optionId: 'always' })
  })

  it.each([
    ['Enter', 'allow'],
    ['Escape', 'deny']
  ])('%s picks %s', (k, optionId) => {
    const answer = mount(approval)
    key(document.querySelector('.request'), { key: k })
    expect(answer).toHaveBeenCalledWith('s1', 'r1', { kind: 'permission', optionId })
  })

  it("doesn't take the caret from text being written elsewhere", () => {
    const editor = document.createElement('textarea')
    editor.value = 'half a sentence'
    document.body.appendChild(editor)
    editor.focus()
    window.gloss = { requests: { answer: vi.fn() } } as unknown as GlossApi
    const el = document.createElement('div')
    document.body.appendChild(el)
    root = createRoot(el)
    act(() => root!.render(<RequestCard request={approval} />))
    expect(document.activeElement).toBe(editor)
    editor.remove()
  })

  it.each([
    ['takes focus from an empty editor (its placeholder is not text)', '', true],
    ['leaves focus in an editor with text in it', 'half a sentence', false]
  ])('%s', (_name, typed, takes) => {
    const editor = document.createElement('div')
    editor.tabIndex = 0
    // jsdom doesn't implement contenteditable.
    Object.defineProperty(editor, 'isContentEditable', { value: true })
    editor.innerHTML = `<span class="cm-placeholder">${typed ? '' : 'Message the agent'}</span>${typed}`
    document.body.replaceChildren(editor)
    editor.focus()
    window.gloss = { requests: { answer: vi.fn() } } as unknown as GlossApi
    const el = document.createElement('div')
    document.body.appendChild(el)
    root = createRoot(el)
    act(() => root!.render(<RequestCard request={approval} />))
    expect(document.activeElement).toBe(takes ? document.querySelector('.request') : editor)
  })

  it('picks choices with number keys in the focused choice, submits with Enter and declines with Esc', async () => {
    const fields = questionFields({
      type: 'object',
      properties: {
        db: { type: 'string', title: 'Database', enum: ['Postgres', 'SQLite'] },
        extras: { type: 'array', title: 'Extras', items: { enum: ['Cache', 'Search'] } }
      }
    })
    const answer = mount({ ...base, kind: 'question', message: 'Pick', fields })
    const form = document.querySelector('form')!
    expect(document.activeElement).toBe(form)
    // Number keys work in the first choice until another one is focused.
    expect([...document.querySelectorAll('.request-field')[0].querySelectorAll('.request-key')].map((k) => k.textContent)).toEqual(['1', '2'])
    key(form, { key: '2' })
    const extras = document.querySelectorAll('.request-field')[1]
    act(() => extras.querySelector<HTMLInputElement>('input')!.focus())
    key(document.activeElement, { key: '1' })
    key(document.activeElement, { key: '2' })
    key(document.activeElement, { key: '1' })
    key(document.activeElement, { key: 'Enter' })
    expect(answer).toHaveBeenLastCalledWith('s1', 'r1', { kind: 'question', action: 'accept', content: { db: 'SQLite', extras: ['Search'] } })
    // Keys wait while an answer is being sent.
    await act(async () => {})
    key(form, { key: 'Escape' })
    expect(answer).toHaveBeenLastCalledWith('s1', 'r1', { kind: 'question', action: 'decline' })
  })

  it('leaves digits to a text box', () => {
    const fields = questionFields({ type: 'object', properties: { pick: { type: 'string', enum: ['a', 'b'] }, pick_custom: { type: 'string', title: 'Other' } } })
    const answer = mount({ ...base, kind: 'question', message: 'Pick', fields })
    const other = document.querySelector<HTMLInputElement>('.request-option.other input')!
    act(() => other.focus())
    key(other, { key: '1' })
    expect(document.querySelector<HTMLInputElement>('input[type="radio"]')!.checked).toBe(false)
    expect(answer).not.toHaveBeenCalled()
  })
})
