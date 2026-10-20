// The Gloss bead and wordmark (docs/BRAND.md), and the title bar that shows them. The
// bead is the app icon's SVG; up to 32 px it uses the small-size version, which holds up
// better there.
const bead = new URL('../../../build/icon.svg', import.meta.url).href
const beadSmall = new URL('../../../build/icon-small.svg', import.meta.url).href

export function BrandMark({ size }: { size: number }): React.JSX.Element {
  return <img className="brand-mark" src={size <= 32 ? beadSmall : bead} width={size} height={size} alt="" />
}

/** The bead and the lowercase wordmark, read as "Gloss". */
export function Wordmark({ size }: { size: number }): React.JSX.Element {
  return (
    <span className="wordmark" style={{ fontSize: size }} role="img" aria-label="Gloss">
      <BrandMark size={Math.round(size * 1.15)} />
      <span aria-hidden="true">gloss</span>
    </span>
  )
}

/**
 * The window's title bar (SPEC → Title bar): the brand, and room to drag the window.
 * The system's window controls sit over its end (main sets them up).
 */
export function TitleBar(): React.JSX.Element {
  return (
    <header className="title-bar">
      <div className="title-brand">
        <Wordmark size={17} />
      </div>
    </header>
  )
}
