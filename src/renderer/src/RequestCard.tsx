// What the agent is waiting on the user for, in the log of the thread whose turn asked
// (SPEC → Questions and approvals): an approval with the agent's options, or a question
// as a form built from its JSON Schema. A card takes focus when it appears, unless the
// user is typing elsewhere; while it has focus, number keys pick, Enter answers and Esc
// declines or rejects.
import { useLayoutEffect, useRef, useState } from 'react'
import { MessageCircleQuestion, ShieldQuestion } from 'lucide-react'
import { answerContent, answerError, type AnswerValue, type QuestionField, type RequestAnswer, type UserRequest } from '@shared/requests'
import type { ToolCall } from '@shared/types'
import { FOCUS_COMPOSER } from './Composer'
import { errorText } from './errors'
import { Markdown } from './Markdown'
import { hasDetails, ToolDetails } from './ToolDetails'

type Permission = Extract<UserRequest, { kind: 'permission' }>
type Question = Extract<UserRequest, { kind: 'question' }>

export function RequestCard({ request }: { request: UserRequest }): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  async function answer(a: RequestAnswer): Promise<void> {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError(null)
    try {
      // The card goes away once the main process reports the request answered.
      await window.gloss.requests.answer(request.sessionId, request.id, a)
    } catch (err) {
      setError(errorText(err))
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  return request.kind === 'permission' ? (
    <PermissionCard request={request} pending={pending} error={error} onAnswer={(a) => void answer(a)} />
  ) : (
    <QuestionCard request={request} pending={pending} error={error} onAnswer={(a) => void answer(a)} />
  )
}

type CardProps<R> = { request: R; pending: boolean; error: string | null; onAnswer(answer: RequestAnswer): void }

/** Whether `el` takes typed text (so digits and Enter keep their usual meaning there). */
function isTextEntry(el: EventTarget | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !['radio', 'checkbox', 'button', 'submit'].includes(el.type)
  return el instanceof HTMLElement && el.isContentEditable
}

/** The user is typing outside the card: an editor or field elsewhere with something in it, or another card. */
function busyElsewhere(card: HTMLElement): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLElement) || card.contains(el)) return false
  if (el.closest('.request')) return true
  if (!isTextEntry(el)) return false
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.trim() !== ''
  // An editor's placeholder (CodeMirror's) isn't text the user wrote.
  const placeholder = [...el.querySelectorAll('.cm-placeholder')].map((p) => p.textContent ?? '').join('')
  return (el.textContent ?? '').replace(placeholder, '').trim() !== ''
}

/**
 * Focuses the card when it appears, unless that would take the caret from what the user
 * is writing. When it goes away (answered) with focus inside, the composer gets it back.
 */
function useTakeFocus(ref: React.RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const card = ref.current
    if (!card) return
    if (!busyElsewhere(card)) card.focus({ preventScroll: true })
    let inside = card.contains(document.activeElement)
    const onIn = (): void => { inside = true }
    const onOut = (e: FocusEvent): void => { inside = card.contains(e.relatedTarget as Node | null) }
    card.addEventListener('focusin', onIn)
    card.addEventListener('focusout', onOut)
    return () => {
      card.removeEventListener('focusin', onIn)
      card.removeEventListener('focusout', onOut)
      if (inside) {
        setTimeout(() => {
          if (document.activeElement === document.body || !document.activeElement) window.dispatchEvent(new Event(FOCUS_COMPOSER))
        })
      }
    }
  }, [ref])
}

/** 1 to 9 for a plain digit key, else null. */
function digit(e: React.KeyboardEvent): number | null {
  if (e.ctrlKey || e.altKey || e.metaKey || !/^[1-9]$/.test(e.key)) return null
  return Number(e.key)
}

/** A key hint, shown while the card has focus. */
function Key({ children }: { children: string }): React.JSX.Element {
  return <kbd className="request-key" aria-hidden>{children}</kbd>
}

const OPTION_TITLES: Record<string, string> = {
  allow_always: 'The agent remembers this and stops asking for requests like it (for this session, or as a saved rule).',
  reject_always: 'The agent remembers this and refuses requests like it from now on.'
}

function PermissionCard({ request, pending, error, onAnswer }: CardProps<Permission>): React.JSX.Element {
  const ref = useRef<HTMLElement>(null)
  useTakeFocus(ref)
  // The details the tool row would show: what it will change or run.
  const toolCall: ToolCall = {
    id: request.toolCallId,
    sessionId: request.sessionId,
    messageSeq: 0,
    threadId: request.threadId,
    title: request.title,
    status: 'pending',
    ...(request.toolKind ? { kind: request.toolKind } : {}),
    ...(request.content !== undefined ? { content: request.content } : {})
  }
  const { options } = request
  const firstAllow = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind.startsWith('allow'))
  const firstReject = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind.startsWith('reject'))
  const pick = (id: string): void => onAnswer({ kind: 'permission', optionId: id })
  function onKeyDown(e: React.KeyboardEvent): void {
    if (pending) return
    const n = digit(e)
    const option = n !== null ? options[n - 1] : e.key === 'Escape' ? firstReject : undefined
    // Enter on a focused button presses that button.
    const enter = e.key === 'Enter' && !(e.target instanceof HTMLButtonElement) ? firstAllow : undefined
    const chosen = option ?? enter
    if (!chosen) return
    e.preventDefault()
    e.stopPropagation()
    pick(chosen.id)
  }
  return (
    <section ref={ref} className="request" role="group" aria-label="Approval needed" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="request-head">
        <ShieldQuestion className="request-icon" aria-hidden />
        <span className="request-title">
          <span className="request-label">Approve?</span> {request.title}
        </span>
      </div>
      {request.command && request.command !== request.title && <pre className="request-command">{request.command}</pre>}
      {hasDetails(toolCall) && (
        <div className="request-details">
          <ToolDetails toolCall={toolCall} />
        </div>
      )}
      <div className="request-actions">
        {options.map((o, i) => (
          <button
            key={o.id}
            type="button"
            className={o === firstAllow ? 'primary sm' : 'sm'}
            disabled={pending}
            title={[
              OPTION_TITLES[o.kind],
              i < 9 ? `Press ${i + 1}${o === firstAllow ? ' or Enter' : o === firstReject ? ' or Esc' : ''}.` : ''
            ].filter(Boolean).join(' ')}
            onClick={() => pick(o.id)}
          >
            {i < 9 && <Key>{String(i + 1)}</Key>}
            {o.name}
          </button>
        ))}
      </div>
      {error && <p className="request-error" role="alert">{error}</p>}
    </section>
  )
}

type Values = Record<string, AnswerValue | undefined>

function initialValues(fields: QuestionField[]): Values {
  const values: Values = {}
  for (const f of fields) if ('default' in f && f.default !== undefined) values[f.key] = f.default
  return values
}

/**
 * A free-text field that goes with the choice before it: the agent's "other" answer
 * (the Claude adapter names it `<choice>_custom` and titles it "Other").
 */
function isOtherFor(field: QuestionField, choice: QuestionField | undefined): boolean {
  return field.kind === 'text' && choice?.kind === 'choice' && (field.key === `${choice.key}_custom` || field.title === 'Other')
}

type Choice = Extract<QuestionField, { kind: 'choice' }>

function pickedOf(value: AnswerValue | undefined): string[] {
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
}

/** A choice's value after picking `option`: a multiple choice toggles it; a single one picks it, or unpicks it if optional. */
function toggled(field: Choice, value: AnswerValue | undefined, option: string): AnswerValue | undefined {
  const picked = pickedOf(value)
  const on = picked.includes(option)
  if (field.multiple) return on ? picked.filter((p) => p !== option) : [...picked, option]
  return on && !field.required ? undefined : option
}

function QuestionCard({ request, pending, error, onAnswer }: CardProps<Question>): React.JSX.Element {
  const ref = useRef<HTMLFormElement>(null)
  useTakeFocus(ref)
  const [values, setValues] = useState<Values>(() => initialValues(request.fields))
  const { fields } = request
  const choices = fields.filter((f): f is Choice => f.kind === 'choice')
  /** The choice number keys pick in: the one last focused, else the first. */
  const [activeKey, setActiveKey] = useState<string | undefined>(choices[0]?.key)
  const active = choices.find((f) => f.key === activeKey) ?? choices[0]
  const content = answerContent(values)
  const problem = answerError(fields, content)
  const set = (key: string, value: AnswerValue | undefined): void => setValues((v) => ({ ...v, [key]: value }))
  const submit = (): void => {
    if (!problem) onAnswer({ kind: 'question', action: 'accept', content })
  }
  function onKeyDown(e: React.KeyboardEvent): void {
    if (pending) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onAnswer({ kind: 'question', action: 'decline' })
      return
    }
    // Typed text keeps its digits; Enter in a field submits the form natively.
    if (isTextEntry(e.target)) return
    const n = digit(e)
    if (n !== null && active && active.options[n - 1]) {
      e.preventDefault()
      set(active.key, toggled(active, values[active.key], active.options[n - 1].value))
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault()
      submit()
    }
  }
  return (
    <form
      ref={ref}
      className="request question"
      aria-label="Question from the agent"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="request-head">
        <MessageCircleQuestion className="request-icon" aria-hidden />
        <div className="request-message">
          <Markdown text={request.message} />
        </div>
      </div>
      {fields.map((f, i) => {
        if (isOtherFor(f, fields[i - 1])) return null
        const other = fields[i + 1] && isOtherFor(fields[i + 1], f) ? fields[i + 1] : undefined
        return (
          <FieldInput
            key={f.key}
            field={f}
            other={other}
            values={values}
            disabled={pending}
            numbered={f === active}
            onFocus={() => f.kind === 'choice' && setActiveKey(f.key)}
            onChange={set}
          />
        )
      })}
      <div className="request-actions">
        <button
          type="submit"
          className="primary sm"
          disabled={pending || problem !== null}
          title={problem ?? 'Press Enter.'}
        >
          Submit
          <Key>Enter</Key>
        </button>
        <button
          type="button"
          className="sm"
          disabled={pending}
          title="Answer without the information: the agent carries on. Press Esc."
          onClick={() => onAnswer({ kind: 'question', action: 'decline' })}
        >
          Decline
          <Key>Esc</Key>
        </button>
        <button
          type="button"
          className="ghost sm"
          disabled={pending}
          title="Stop what the agent was asking for"
          onClick={() => onAnswer({ kind: 'question', action: 'cancel' })}
        >
          Cancel
        </button>
      </div>
      {error && <p className="request-error" role="alert">{error}</p>}
    </form>
  )
}

function FieldInput(props: {
  field: QuestionField
  other?: QuestionField
  values: Values
  disabled: boolean
  /** Number keys pick in this choice: show them. */
  numbered: boolean
  onFocus(): void
  onChange(key: string, value: AnswerValue | undefined): void
}): React.JSX.Element {
  const { field, other, values, disabled, onChange } = props
  const id = `q-${field.key}`
  const head = (field.title || field.description) && (
    <legend className="request-field-head">
      {field.title && <span className="request-field-title">{field.title}</span>}
      {field.description && <span className="request-field-desc">{field.description}</span>}
      {field.required && <span className="sr-only"> (required)</span>}
    </legend>
  )
  switch (field.kind) {
    case 'choice': {
      const value = values[field.key]
      const picked = pickedOf(value)
      return (
        <fieldset className="request-field" disabled={disabled} onFocus={props.onFocus}>
          {head}
          <div className="request-options" role={field.multiple ? 'group' : 'radiogroup'}>
            {field.options.map((o, i) => {
              const on = picked.includes(o.value)
              return (
                <label key={o.value} className={on ? 'request-option on' : 'request-option'}>
                  <input
                    type={field.multiple ? 'checkbox' : 'radio'}
                    name={id}
                    checked={on}
                    onChange={() => onChange(field.key, field.multiple ? toggled(field, value, o.value) : o.value)}
                    // A radio can't be unchecked by clicking it: an optional single choice can.
                    onClick={() => {
                      if (!field.multiple && on && !field.required) onChange(field.key, undefined)
                    }}
                  />
                  <span className="request-option-text">
                    <span>{o.title}</span>
                    {o.description && <span className="muted">{o.description}</span>}
                  </span>
                  {props.numbered && i < 9 && <Key>{String(i + 1)}</Key>}
                </label>
              )
            })}
            {other && (
              <label className="request-option other">
                <span className="request-other-label">{other.title ?? 'Other'}</span>
                <input
                  type="text"
                  value={typeof values[other.key] === 'string' ? (values[other.key] as string) : ''}
                  placeholder={other.description ?? 'Type your own answer'}
                  onChange={(e) => onChange(other.key, e.target.value)}
                />
              </label>
            )}
          </div>
        </fieldset>
      )
    }
    case 'text': {
      const value = values[field.key]
      const type = field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : field.format === 'date' ? 'date' : field.format === 'date-time' ? 'datetime-local' : 'text'
      return (
        <fieldset className="request-field" disabled={disabled}>
          {head}
          <input
            id={id}
            type={type}
            className="request-text"
            value={typeof value === 'string' ? value : ''}
            maxLength={field.maxLength}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
        </fieldset>
      )
    }
    case 'number': {
      const value = values[field.key]
      return (
        <fieldset className="request-field" disabled={disabled}>
          {head}
          <input
            id={id}
            type="number"
            className="request-text"
            value={typeof value === 'number' ? value : ''}
            min={field.minimum}
            max={field.maximum}
            step={field.integer ? 1 : 'any'}
            onChange={(e) => onChange(field.key, e.target.value === '' ? undefined : Number(e.target.value))}
          />
        </fieldset>
      )
    }
    case 'boolean':
      return (
        <fieldset className="request-field" disabled={disabled}>
          <label className="request-option">
            <input type="checkbox" checked={values[field.key] === true} onChange={(e) => onChange(field.key, e.target.checked)} />
            <span className="request-option-text">
              <span>{field.title ?? field.key}</span>
              {field.description && <span className="muted">{field.description}</span>}
            </span>
          </label>
        </fieldset>
      )
    case 'unsupported':
      return (
        <fieldset className="request-field" disabled>
          {head}
          <p className="muted">Gloss can’t show this field{field.required ? ', so this question can only be declined or cancelled' : ''}.</p>
        </fieldset>
      )
  }
}
