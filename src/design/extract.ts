// Runs in the browser; kept as source text so the generated spec and the canvas loader share it.
export const EXTRACT = `() => {
  const roles = { BUTTON: "button", A: "link", H1: "heading", H2: "heading", H3: "heading", INPUT: "textbox" };
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
    const name = (el.getAttribute("aria-label") || own).replace(/\\s+/g, " ");
    if (!name || name.length > 120) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const s = getComputedStyle(el);
    out.push({
      role: el.getAttribute("role") || roles[el.tagName] || "text", name,
      color: s.color, background: s.backgroundColor,
      fontFamily: s.fontFamily.split(",")[0].replace(/["']/g, "").trim(),
      fontSize: parseFloat(s.fontSize), fontWeight: Number(s.fontWeight), lineHeight: parseFloat(s.lineHeight) || 0,
      padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].map(parseFloat),
      radius: parseFloat(s.borderTopLeftRadius) || 0, width: r.width, height: r.height,
    });
  }
  return out;
}`;
