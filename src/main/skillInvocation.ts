import { isMap, parseDocument } from 'yaml'
import type { SkillInvocation } from '../shared/plugins'

function document(source: string, label: string) {
  const doc = parseDocument(source)
  if (doc.errors.length || doc.contents !== null && !isMap(doc.contents)) throw new Error(`${label} must contain a valid YAML mapping.`)
  return doc
}

function flag(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value === 'boolean') return value
  // Claude also accepts YAML 1.1 boolean spellings.
  if (/^(true|yes|on|1)$/i.test(String(value))) return true
  if (/^(false|no|off|0)$/i.test(String(value))) return false
  throw new Error('Skill invocation settings must be true or false.')
}

/** Keep native policies in the shared files so junction and copy deployments agree. */
export function skillInvocation(instructions: string, metadata?: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(instructions)
  if (!frontmatter) throw new Error('SKILL.md needs YAML frontmatter.')
  const skill = document(frontmatter[1], 'SKILL.md frontmatter')
  const openai = document(metadata ?? '', 'agents/openai.yaml')
  const claudeDirect = flag(skill.get('disable-model-invocation'), false)
  const opencodeDirect = !flag(skill.getIn(['metadata', 'opencode/autoinvoke']), !claudeDirect)
  const codexDirect = !flag(openai.getIn(['policy', 'allow_implicit_invocation']), true)
  const invocation = claudeDirect === codexDirect && claudeDirect === opencodeDirect
    ? claudeDirect ? 'direct' : 'automatic'
    : 'mixed'
  return {
    invocation: invocation as SkillInvocation | 'mixed',
    update(mode: SkillInvocation): { instructions: string; metadata: string } {
      const direct = mode === 'direct'
      skill.set('disable-model-invocation', direct)
      // Explicit invocation stays available even if the file previously hid it.
      skill.set('user-invocable', true)
      skill.setIn(['metadata', 'opencode/autoinvoke'], !direct)
      openai.setIn(['policy', 'allow_implicit_invocation'], !direct)
      return { instructions: `---\n${skill.toString()}---${frontmatter[2]}${instructions.slice(frontmatter[0].length)}`, metadata: openai.toString() }
    }
  }
}
