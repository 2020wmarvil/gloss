import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { skillInvocation } from './skillInvocation'

const instructions = '---\r\n# Keep the author comment\r\nname: example\r\ndescription: An example\r\nallowed-tools: Read\r\n---\r\n\r\n# Body\r\nKeep **this** unchanged.\r\n'

it('preserves the instruction body and unrelated native metadata', () => {
  const body = instructions.slice(instructions.indexOf('\r\n\r\n# Body'))
  const updated = skillInvocation(instructions, '# Metadata comment\ninterface:\n  display_name: Example\ndependencies:\n  tools: []\n').update('direct')
  expect(updated.instructions.endsWith(body)).toBe(true)
  expect(updated.instructions).toContain('# Keep the author comment')
  expect(updated.instructions).toContain('allowed-tools: Read')
  expect(updated.metadata).toContain('# Metadata comment')
  expect(parse(updated.metadata)).toMatchObject({ interface: { display_name: 'Example' }, dependencies: { tools: [] }, policy: { allow_implicit_invocation: false } })
  expect(skillInvocation(updated.instructions, updated.metadata).invocation).toBe('direct')
  const automatic = skillInvocation(updated.instructions, updated.metadata).update('automatic')
  expect(skillInvocation(automatic.instructions, automatic.metadata).invocation).toBe('automatic')
})

it('detects an OpenCode override that conflicts with the other agents', () => {
  const source = instructions.replace('allowed-tools: Read', 'disable-model-invocation: true\nmetadata:\n  opencode/autoinvoke: true')
  const metadata = 'policy:\n  allow_implicit_invocation: false\n'
  expect(skillInvocation(source, metadata).invocation).toBe('mixed')
  const aligned = skillInvocation(source, metadata).update('direct')
  expect(skillInvocation(aligned.instructions, aligned.metadata).invocation).toBe('direct')
})

it('rejects malformed policies instead of overwriting them', () => {
  expect(() => skillInvocation(instructions, 'policy: [')).toThrow(/valid YAML mapping/)
  expect(() => skillInvocation(instructions, '- scalar')).toThrow(/valid YAML mapping/)
  expect(() => skillInvocation(instructions, 'policy:\n  allow_implicit_invocation: sometimes')).toThrow(/true or false/)
})
