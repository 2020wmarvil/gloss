import { describe, expect, it } from 'vitest'
import { answerContent, answerError, questionFields } from './requests'

describe('questionFields', () => {
  it('reads choices, text, numbers and booleans from an elicitation schema', () => {
    const fields = questionFields({
      type: 'object',
      properties: {
        pick: { type: 'string', title: 'Pick', enum: ['a', 'b'] },
        titled: { type: 'string', oneOf: [{ const: 'x', title: 'Ex', description: 'The x' }] },
        many: { type: 'array', items: { anyOf: [{ const: 'p', title: 'P' }] }, minItems: 1 },
        plain: { type: 'array', items: { type: 'string', enum: ['q'] } },
        email: { type: 'string', format: 'email', default: 'a@b.c' },
        count: { type: 'integer', minimum: 1, maximum: 3 },
        ok: { type: 'boolean', default: true },
        odd: { type: 'object' }
      },
      required: ['pick', 'count']
    })
    expect(fields).toEqual([
      { key: 'pick', title: 'Pick', required: true, kind: 'choice', multiple: false, options: [{ value: 'a', title: 'a' }, { value: 'b', title: 'b' }] },
      { key: 'titled', required: false, kind: 'choice', multiple: false, options: [{ value: 'x', title: 'Ex', description: 'The x' }] },
      { key: 'many', required: false, kind: 'choice', multiple: true, options: [{ value: 'p', title: 'P' }], min: 1 },
      { key: 'plain', required: false, kind: 'choice', multiple: true, options: [{ value: 'q', title: 'q' }] },
      { key: 'email', required: false, kind: 'text', format: 'email', default: 'a@b.c' },
      { key: 'count', required: true, kind: 'number', integer: true, minimum: 1, maximum: 3 },
      { key: 'ok', required: false, kind: 'boolean', default: true },
      { key: 'odd', required: false, kind: 'unsupported' }
    ])
  })

  it('has no fields for a schema without properties', () => {
    expect(questionFields(null)).toEqual([])
    expect(questionFields({ type: 'object' })).toEqual([])
  })
})

describe('answerError', () => {
  const fields = questionFields({
    type: 'object',
    properties: {
      pick: { type: 'string', title: 'Pick', enum: ['a', 'b'] },
      many: { type: 'array', items: { enum: ['p', 'q', 'r'] }, maxItems: 2 },
      name: { type: 'string', minLength: 2, pattern: '^[a-z]+$' },
      count: { type: 'integer', maximum: 3 }
    },
    required: ['pick']
  })

  it('accepts a valid answer and leaves unset optional fields out', () => {
    const content = answerContent({ pick: 'a', many: [], name: '', count: undefined })
    expect(content).toEqual({ pick: 'a' })
    expect(answerError(fields, content)).toBeNull()
    expect(answerError(fields, { pick: 'b', many: ['p', 'q'], name: 'ok', count: 2 })).toBeNull()
  })

  it('names what is wrong', () => {
    expect(answerError(fields, {})).toBe('Pick needs an answer.')
    expect(answerError(fields, { pick: 'z' })).toBe('Pick: not one of the choices.')
    expect(answerError(fields, { pick: ['a'] })).toBe('Pick: pick one.')
    expect(answerError(fields, { pick: 'a', many: ['p', 'q', 'r'] })).toBe('many: pick at most 2.')
    expect(answerError(fields, { pick: 'a', name: 'x' })).toBe('name: at least 2 characters.')
    expect(answerError(fields, { pick: 'a', name: 'AB' })).toBe('name: not in the expected format.')
    expect(answerError(fields, { pick: 'a', count: 2.5 })).toBe('count: expected a whole number.')
    expect(answerError(fields, { pick: 'a', count: 4 })).toBe('count: at most 3.')
    expect(answerError(fields, { pick: 'a', extra: 'x' })).toBe('Unknown field extra.')
  })
})
