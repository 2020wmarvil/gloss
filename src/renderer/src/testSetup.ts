// jsdom has no layout engine. CodeMirror measures text ranges during keyboard
// navigation and animation frames, so give ranges the same empty geometry as elements.
// This setup also runs in node test files, where there is no DOM.
if (typeof Range !== 'undefined') {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => Object.assign([], { item: () => null })
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => new DOMRect()
  }
}
