/**
 * Copy text to the clipboard, and say whether it worked.
 *
 * ⚠️ `navigator.clipboard` only exists in a SECURE context — HTTPS or
 * localhost. This app is served over plain HTTP on the LAN (X4, accepted),
 * so on the real deployment the modern API is simply absent, and a Copy
 * button built on it alone would work in every local test and do nothing at
 * home. The fallback is the old selection + `execCommand("copy")`, which is
 * deprecated but still honoured by Safari, Chrome and Firefox.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission refused or document not focused — try the old way.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
