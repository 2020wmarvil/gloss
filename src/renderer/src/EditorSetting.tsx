import { useEffect, useState } from 'react'
import { EDITOR_PRESETS } from '@shared/settings'
import { Select } from './Select'

const CUSTOM = 'custom'
const isPreset = (value: string): boolean => EDITOR_PRESETS.some((preset) => preset.value === value)

export function EditorSetting({ id, value, onChange }: { id: string; value: string; onChange(value: string): void }): React.JSX.Element {
  const [custom, setCustom] = useState(!isPreset(value))
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value); setCustom(!isPreset(value)) }, [value])
  const save = (): void => { if (draft !== value) onChange(draft) }

  return <div className="editor-setting">
    <Select id={id} ariaLabel="External editor" ariaDescribedBy={`${id}-description`}
      value={custom ? CUSTOM : value}
      options={[...EDITOR_PRESETS, { label: 'Custom command...', value: CUSTOM }]}
      onChange={(next) => {
        if (next === CUSTOM) { setDraft(value); setCustom(true) }
        else { setCustom(false); onChange(next) }
      }} />
    {custom && <input className="setting-text" aria-label="Custom editor command" aria-describedby={`${id}-description`}
      spellCheck={false} value={draft} placeholder="code -g {file}:{line}"
      onChange={(e) => setDraft(e.target.value)} onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save()
        if (e.key === 'Escape') { setDraft(value); setCustom(!isPreset(value)); e.stopPropagation() }
      }} />}
  </div>
}
