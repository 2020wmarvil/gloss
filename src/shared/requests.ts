// What an agent asks the user mid-turn (SPEC → Questions and approvals): a question
// (ACP form elicitation) or an approval (session/request_permission). Pure data and
// helpers shared by the main process and the renderer.

/** One of the agent's answers to an approval request. */
export type PermissionChoice = {
  id: string
  name: string
  /** ACP's `allow_once`, `allow_always`, `reject_once` or `reject_always`. */
  kind: string
}

export type ChoiceOption = { value: string; title: string; description?: string }

/** A field of a question's form, from one property of its JSON Schema. */
export type QuestionField = { key: string; title?: string; description?: string; required: boolean } & (
  | { kind: 'choice'; multiple: boolean; options: ChoiceOption[]; min?: number; max?: number; default?: string | string[] }
  | { kind: 'text'; format?: string; minLength?: number; maxLength?: number; pattern?: string; default?: string }
  | { kind: 'number'; integer: boolean; minimum?: number; maximum?: number; default?: number }
  | { kind: 'boolean'; default?: boolean }
  /** A type Gloss can't show. Required ones leave only Decline and Cancel. */
  | { kind: 'unsupported' }
)

/** Something the agent is waiting on the user for. Kept in memory while the request is open. */
export type UserRequest = {
  id: string
  sessionId: string
  /** The thread whose turn asked (null = main). */
  threadId: string | null
  createdAt: number
} & (
  | {
      kind: 'permission'
      /** The tool call's title. */
      title: string
      toolCallId: string
      toolKind?: string
      /** The tool call's ACP content (a diff, text), shown as the tool's details. */
      content?: unknown
      /** What it will run, when the agent says (a shell command). */
      command?: string
      options: PermissionChoice[]
    }
  | { kind: 'question'; message: string; fields: QuestionField[] }
)

export type AnswerValue = string | number | boolean | string[]

export type RequestAnswer =
  | { kind: 'permission'; optionId: string }
  | { kind: 'question'; action: 'accept'; content: Record<string, AnswerValue> }
  /** Decline: answer without the information. Cancel: stop what the agent was doing. */
  | { kind: 'question'; action: 'decline' | 'cancel' }
  /** Permission requests: answers neither allow nor reject (the turn was cancelled). */
  | { kind: 'permission'; cancelled: true }

type Raw = Record<string, unknown>

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function enumOptions(values: unknown, titled: unknown): ChoiceOption[] | null {
  if (Array.isArray(titled)) {
    return titled
      .filter((o): o is Raw => isObject(o) && typeof o.const === 'string')
      .map((o) => ({
        value: o.const as string,
        title: str(o.title) ?? (o.const as string),
        ...(str(o.description) ? { description: str(o.description) } : {})
      }))
  }
  if (Array.isArray(values)) {
    return values.filter((v): v is string => typeof v === 'string').map((v) => ({ value: v, title: v }))
  }
  return null
}

/** The form fields of an elicitation's `requestedSchema`, in property order. */
export function questionFields(schema: unknown): QuestionField[] {
  if (!isObject(schema) || !isObject(schema.properties)) return []
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((k) => typeof k === 'string') : [])
  return Object.entries(schema.properties).map(([key, raw]): QuestionField => {
    const p = isObject(raw) ? raw : {}
    const base = {
      key,
      required: required.has(key),
      ...(str(p.title) ? { title: str(p.title) } : {}),
      ...(str(p.description) ? { description: str(p.description) } : {})
    }
    switch (p.type) {
      case 'string': {
        const options = enumOptions(p.enum, p.oneOf)
        if (options) {
          return { ...base, kind: 'choice', multiple: false, options, ...(typeof p.default === 'string' ? { default: p.default } : {}) }
        }
        return {
          ...base,
          kind: 'text',
          ...(str(p.format) ? { format: str(p.format) } : {}),
          ...(num(p.minLength) !== undefined ? { minLength: num(p.minLength) } : {}),
          ...(num(p.maxLength) !== undefined ? { maxLength: num(p.maxLength) } : {}),
          ...(str(p.pattern) ? { pattern: str(p.pattern) } : {}),
          ...(typeof p.default === 'string' ? { default: p.default } : {})
        }
      }
      case 'number':
      case 'integer':
        return {
          ...base,
          kind: 'number',
          integer: p.type === 'integer',
          ...(num(p.minimum) !== undefined ? { minimum: num(p.minimum) } : {}),
          ...(num(p.maximum) !== undefined ? { maximum: num(p.maximum) } : {}),
          ...(num(p.default) !== undefined ? { default: num(p.default) } : {})
        }
      case 'boolean':
        return { ...base, kind: 'boolean', ...(typeof p.default === 'boolean' ? { default: p.default } : {}) }
      case 'array': {
        const items = isObject(p.items) ? p.items : {}
        const options = enumOptions(items.enum, items.anyOf)
        if (!options) return { ...base, kind: 'unsupported' }
        return {
          ...base,
          kind: 'choice',
          multiple: true,
          options,
          ...(num(p.minItems) !== undefined ? { min: num(p.minItems) } : {}),
          ...(num(p.maxItems) !== undefined ? { max: num(p.maxItems) } : {}),
          ...(Array.isArray(p.default) ? { default: p.default.filter((v): v is string => typeof v === 'string') } : {})
        }
      }
      default:
        return { ...base, kind: 'unsupported' }
    }
  })
}

/** Whether a value counts as given: empty text and empty selections don't. */
function given(v: AnswerValue | undefined): v is AnswerValue {
  return v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)
}

/** What is wrong with a form answer, or null if it can be sent. Unset optional fields are left out of the content. */
export function answerError(fields: QuestionField[], content: Record<string, AnswerValue>): string | null {
  for (const key of Object.keys(content)) {
    if (!fields.some((f) => f.key === key)) return `Unknown field ${key}.`
  }
  for (const f of fields) {
    const v = content[f.key]
    const name = f.title ?? f.key
    if (!given(v)) {
      if (f.required) return `${name} needs an answer.`
      continue
    }
    switch (f.kind) {
      case 'choice': {
        const values = Array.isArray(v) ? v : [v]
        if (!f.multiple && Array.isArray(v)) return `${name}: pick one.`
        if (values.some((x) => typeof x !== 'string' || !f.options.some((o) => o.value === x))) return `${name}: not one of the choices.`
        if (f.min !== undefined && values.length < f.min) return `${name}: pick at least ${f.min}.`
        if (f.max !== undefined && values.length > f.max) return `${name}: pick at most ${f.max}.`
        break
      }
      case 'text':
        if (typeof v !== 'string') return `${name}: expected text.`
        if (f.minLength !== undefined && v.length < f.minLength) return `${name}: at least ${f.minLength} characters.`
        if (f.maxLength !== undefined && v.length > f.maxLength) return `${name}: at most ${f.maxLength} characters.`
        if (f.pattern) {
          try {
            if (!new RegExp(f.pattern, 'u').test(v)) return `${name}: not in the expected format.`
          } catch {
            // A pattern JavaScript can't read: leave it to the agent.
          }
        }
        break
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) return `${name}: expected a number.`
        if (f.integer && !Number.isInteger(v)) return `${name}: expected a whole number.`
        if (f.minimum !== undefined && v < f.minimum) return `${name}: at least ${f.minimum}.`
        if (f.maximum !== undefined && v > f.maximum) return `${name}: at most ${f.maximum}.`
        break
      case 'boolean':
        if (typeof v !== 'boolean') return `${name}: expected yes or no.`
        break
      case 'unsupported':
        return `${name} can't be answered in Gloss.`
    }
  }
  return null
}

/** The content to send: given values only. */
export function answerContent(content: Record<string, AnswerValue | undefined>): Record<string, AnswerValue> {
  return Object.fromEntries(Object.entries(content).filter((e): e is [string, AnswerValue] => given(e[1])))
}
