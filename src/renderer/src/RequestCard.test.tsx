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
    expect(buttons.map((b) => b.textContent)).toEqual(['Allow', 'Always allow', 'Reject'])
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
