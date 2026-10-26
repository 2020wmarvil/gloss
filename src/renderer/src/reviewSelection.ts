import { useEffect, type RefObject } from 'react'

/** Native left-drag selection stays inside the diff file where it began. */
export function useReviewFileSelection(scope: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    let body: HTMLElement | null = null
    let origin: HTMLElement | null = null
    let container: HTMLElement | null = null
    const unlock = (): void => {
      origin?.classList.remove('review-selection-origin')
      container?.classList.remove('review-file-selecting')
      origin = container = null
    }
    const onDown = (event: MouseEvent): void => {
      unlock()
      body = null
      if (event.button !== 0 || !(event.target instanceof Element) || !scope.current?.contains(event.target)) return
      body = event.target.closest('.code[data-line]')?.closest<HTMLElement>('.diff-body') ?? null
      if (!body) return
      origin = body.closest('.diff-file')
      container = scope.current
      // Apply before the browser begins native selection, so other files
      // never paint a highlight that would then need to be removed.
      origin?.classList.add('review-selection-origin')
      container.classList.add('review-file-selecting')
    }
    const constrain = (): void => {
      const selection = window.getSelection()
      if (!body?.isConnected || !selection?.anchorNode || !selection.focusNode ||
        !body.contains(selection.anchorNode) || body.contains(selection.focusNode)) return
      const side = body.dataset.sel
      const cells = [...body.querySelectorAll<HTMLElement>('.code[data-line]')]
        .filter((cell) => !side || cell.dataset.side === side)
      const before = Boolean(body.compareDocumentPosition(selection.focusNode) & Node.DOCUMENT_POSITION_PRECEDING)
      const cell = before ? cells[0] : cells[cells.length - 1]
      if (!cell) return
      const edge = cell.querySelector('.w') ?? cell
      selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset, edge, before ? 0 : edge.childNodes.length)
    }
    const onUp = (): void => {
      constrain()
      unlock()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('selectionchange', constrain)
    document.addEventListener('mouseup', onUp)
    window.addEventListener('blur', unlock)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('selectionchange', constrain)
      document.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', unlock)
      unlock()
    }
  }, [scope])
}
