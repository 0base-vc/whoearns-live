/**
 * Serialize a value into a JSON-LD `<script>` body that is safe to embed
 * via `{@html ...}` inside HTML.
 *
 * `JSON.stringify` does not escape `<`, so user-controlled (or even
 * operator-controlled) strings containing `</script>` would close the
 * surrounding `<script type="application/ld+json">` tag and let the
 * browser parse the rest as new HTML — i.e. stored XSS. Replacing every
 * `<` with its `<` JSON escape makes the output unparseable as an
 * HTML tag while keeping the JSON semantically identical.
 *
 * Always use this helper instead of `JSON.stringify(...)` when the
 * result is going to be embedded inside an HTML `<script>` block.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
