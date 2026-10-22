// What the agent is waiting on the user for, in the log of the thread whose turn asked
// (SPEC → Questions and approvals): an approval with the agent's options, or a question
// as a form built from its JSON Schema.
import { useRef, useState } from 'react'
import { MessageCircleQuestion, ShieldQuestion } from 'lucide-react'
import { answerContent, answerError, type AnswerValue, type QuestionField, type RequestAnswer, type UserRequest } from '@shared/requests'
import type { ToolCall } from '@shared/types'
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

const OPTION_TITLES: Record<string, string> = {
  allow_always: 'The agent remembers this and stops asking for requests like it (for this session, or as a saved rule).',
  reject_always: 'The agent remembers this and refuses requests like it from now on.'
}

function PermissionCard({ request, pending, error, onAnswer }: CardProps<Permission>): React.JSX.Element {
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
  const firstAllow = request.options.find((o) => o.kind === 'allow_once') ?? request.options.find((o) => o.kind.startsWith('allow'))
  return (
    <section className="request" role="group" aria-label="Approval needed">
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
        {request.options.map((o) => (
          <button
            key={o.id}
            className={o === firstAllow ? 'primary sm' : 'sm'}
            disabled={pending}
            title={OPTION_TITLES[o.kind]}
            onClick={() => onAnswer({ kind: 'permission', optionId: o.id })}
          >
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

function QuestionCard({ request, pending, error, onAnswer }: CardProps<Question>): React.JSX.Element {
  const [values, setValues] = useState<Values>(() => initialValues(request.fields))
  const content = answerContent(values)
  const problem = answerError(request.fields, content)
  const set = (key: string, value: AnswerValue | undefined): void => setValues((v) => ({ ...v, [key]: value }))
  const { fields } = request
  return (
    <form
      className="request question"
      aria-label="Question from the agent"
      onSubmit={(e) => {
        e.preventDefault()
        if (!problem) onAnswer({ kind: 'question', action: 'accept', content })
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
            onChange={set}
          />
        )
      })}
      <div className="request-actions">
        <button type="submit" className="primary sm" disabled={pending || problem !== null} title={problem ?? undefined}>
          Submit
        </button>
        <button
          type="button"
          className="sm"
          disabled={pending}
          title="Answer without the information: the agent carries on"
          onClick={() => onAnswer({ kind: 'question', action: 'decline' })}
        >
          Decline
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
      const picked = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
      return (
        <fieldset className="request-field" disabled={disabled}>
          {head}
          <div className="request-options" role={field.multiple ? 'group' : 'radiogroup'}>
            {field.options.map((o) => {
              const on = picked.includes(o.value)
              return (
                <label key={o.value} className={on ? 'request-option on' : 'request-option'}>
                  <input
                    type={field.multiple ? 'checkbox' : 'radio'}
                    name={id}
                    checked={on}
                    onChange={() => {
                      if (field.multiple) onChange(field.key, on ? picked.filter((p) => p !== o.value) : [...picked, o.value])
                      else onChange(field.key, o.value)
                    }}
                    // A radio can't be unchecked by clicking it: an optional single choice can.
                    onClick={() => {
                      if (!field.multiple && on && !field.required) onChange(field.key, undefined)
                    }}
                  />
                  <span className="request-option-text">
                    <span>{o.title}</span>
                    {o.description && <span className="muted">{o.description}</span>}
                  </span>
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
