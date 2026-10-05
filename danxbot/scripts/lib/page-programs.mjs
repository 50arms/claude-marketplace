// DX-4539: the programs capture-screenshot.mjs runs inside the page (via Runtime.evaluate).
// Kept apart from argument parsing: this is page-side code, not node-side.

/**
 * True when the page shows something a person would see. Generic, no app-specific selector. Counts: text
 * with a box, a loaded image larger than 1x1, an svg shape, a canvas, a video with a source or poster, a
 * form control, a CSS background image, and an iframe/frame whose own document renders (or which is
 * cross-origin and points at a URL). Open shadow roots are walked. Not counted: display:none or
 * opacity:0 subtrees, whitespace, zero-size boxes, an empty video, an empty iframe. Written as a real
 * function and serialised with toString(), so it must reference nothing outside itself.
 */
function pageRendersContent() {
  const SKIP = new Set(["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT", "HEAD", "TITLE"]);
  const SHAPES = new Set(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "text", "image"]);
  const CONTROLS = new Set(["INPUT", "BUTTON", "SELECT", "TEXTAREA"]);

  const renders = (doc) => {
    const view = doc.defaultView;
    const walk = (node, shown) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          if (shown && child.nodeValue.trim() !== "" && hasBox(node, 0)) return true;
          continue;
        }
        if (child.nodeType !== 1 || SKIP.has(child.tagName)) continue;
        const cs = view.getComputedStyle(child);
        if (cs.display === "none" || Number(cs.opacity) === 0) continue;
        // visibility is inherited but a descendant may override it, so it is passed down rather than pruned.
        const childShown = cs.visibility !== "hidden";
        if (childShown && paints(child, cs)) return true;
        if (child.shadowRoot && walk(child.shadowRoot, childShown)) return true;
        if (walk(child, childShown)) return true;
      }
      return false;
    };
    const hasBox = (el, min) => {
      if (!el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      return r.width > min && r.height > min;
    };
    const paints = (el, cs) => {
      const tag = el.localName;
      if (cs.backgroundImage !== "none" && hasBox(el, 1)) return true;
      if (tag === "img") return el.complete && el.naturalWidth > 1 && el.naturalHeight > 1 && hasBox(el, 1);
      if (tag === "canvas") return hasBox(el, 1);
      if (tag === "video") return hasBox(el, 1) && (el.currentSrc !== "" || el.poster !== "");
      if (tag === "iframe" || tag === "frame") {
        if (!hasBox(el, 1)) return false;
        const inner = el.contentDocument;
        if (inner) return renders(inner);
        return el.src !== "" && el.src !== "about:blank";
      }
      if (CONTROLS.has(el.tagName)) return el.type !== "hidden" && hasBox(el, 0);
      return SHAPES.has(tag) && hasBox(el, 0);
    };
    return doc.documentElement ? walk(doc, true) : false;
  };
  return renders(document);
}

export const PAGE_RENDERS_CONTENT = `(${pageRendersContent.toString()})()`;
