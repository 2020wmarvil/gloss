import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, MapPin, Pencil, X } from 'lucide-react'
import type { Attachment } from '@shared/types'

type ImageAttachment = Extract<Attachment, { kind: 'image' }>

/** The approved compact strip, below the prompt; no controls cover the image. */
export function ComposerAttachments({ attachments, canEditImage, onEditImage, onRemove }: {
  attachments: Attachment[]
  canEditImage(image: ImageAttachment): boolean
  onEditImage(image: ImageAttachment, index: number): void
  onRemove(index: number): void
}): React.JSX.Element {
  const [preview, setPreview] = useState<ImageAttachment | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const images = attachments.map((image, index) => ({ image, index })).filter((item): item is { image: ImageAttachment; index: number } => item.image.kind === 'image')
  const files = attachments.map((file, index) => ({ file, index })).filter((item): item is { file: Extract<Attachment, { kind: 'file' }>; index: number } => item.file.kind === 'file')
  return <div className="composer-attachments">
    {images.length > 0 && <ul className="attachment-strip" aria-label="Attached images">
      {images.map(({ image, index }) => <li className="attachment capture" key={index}>
        <button type="button" className="capture-preview" aria-label={`Preview ${image.name}`} onClick={(e) => { trigger.current = e.currentTarget; setPreview(image) }}>
          <img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} />
        </button>
        <div className="capture-details">
          <div className="capture-filename" title={image.name}>{image.name}</div>
          <div className="capture-meta">{image.pins?.length ? <span className="capture-pins"><MapPin size={10} />{image.pins.length} {image.pins.length === 1 ? 'pin' : 'pins'}</span> : 'Image'}</div>
          <div className="capture-actions">
            {canEditImage(image) && <button type="button" className="capture-edit" aria-label={`Annotate ${image.name}`} onClick={() => onEditImage(image, index)}><Pencil size={13} />Annotate</button>}
            <button type="button" className="attachment-remove" aria-label={`Remove ${image.name}`} onClick={() => onRemove(index)}><X size={14} /></button>
          </div>
        </div>
      </li>)}
    </ul>}
    {files.length > 0 && <ul className="attachment-files" aria-label="Attached files">
      {files.map(({ file, index }) => <li className="attachment" key={index} title={file.path ?? file.name}>
        <FileText size={13} />
        <span className="attachment-name">{file.name}</span>
        <button type="button" className="attachment-remove" aria-label={`Remove ${file.name}`} onClick={() => onRemove(index)}><X size={14} /></button>
      </li>)}
    </ul>}
    {preview && <ImagePreview image={preview} onClose={() => { setPreview(null); trigger.current?.focus() }} />}
  </div>
}

function ImagePreview({ image, onClose }: { image: ImageAttachment; onClose(): void }): React.JSX.Element {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => { close.current?.focus() }, [])
  return createPortal(<div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
    <div className="attachment-preview-dialog" role="dialog" aria-modal="true" aria-label={`Preview ${image.name}`} onKeyDown={(e) => {
      e.stopPropagation()
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if (e.key === 'Tab') { e.preventDefault(); close.current?.focus() }
    }}>
      <img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} />
      <footer><span>{image.name}</span><button type="button" ref={close} onClick={onClose}>Close <kbd>Esc</kbd></button></footer>
    </div>
  </div>, document.body)
}
