/** Raw facts about one element, collected in the browser by the inspect child script. */
export interface RawElement {
  tag: string;
  role?: string;
  /** Approximation of the accessible name. */
  name?: string;
  /** Visible text, only for elements that have no role/name of their own. */
  text?: string;
  type?: string;
  label?: string;
  placeholder?: string;
  /** Present stable attributes only, e.g. { "data-qa": "submit" }. */
  attrs: Record<string, string>;
  href?: string;
  disabled?: boolean;
  required?: boolean;
  checked?: boolean;
}

export type SelectorSource = "data-testid" | "data-qa" | "data-env-id" | "role" | "label" | "placeholder" | "text";

export interface InspectedElement {
  tag: string;
  role?: string;
  name?: string;
  type?: string;
  /** Playwright expression to paste into a page object, using `page`. */
  locator: string;
  source: SelectorSource;
  /** The data-* attribute used, for the data-* sources. */
  attribute?: string;
  /** True when several elements produce the same locator: scope it inside a container instead of using .nth(). */
  ambiguous?: boolean;
  count?: number;
  href?: string;
  disabled?: boolean;
  required?: boolean;
  checked?: boolean;
}

export interface SelectorConfig {
  /** ID_SELECTOR suffix from .env (data-{idSelector}); empty when not configured. */
  idSelector?: string;
  /** Attribute getByTestId() resolves to (use.testIdAttribute). */
  testIdAttribute: string;
}

/** Attributes to look for, in selection priority order. */
export function stableAttributes(idSelector?: string): string[] {
  const attributes = ["data-testid", "data-qa"];
  if (idSelector) {
    const custom = `data-${idSelector}`;
    if (!attributes.includes(custom)) attributes.push(custom);
  }
  return attributes;
}

export function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\s+/g, " ")}'`;
}

function attributeLocator(attribute: string, value: string, config: SelectorConfig): { code: string; source: SelectorSource } {
  const source: SelectorSource = attribute === "data-testid" ? "data-testid" : attribute === "data-qa" ? "data-qa" : "data-env-id";
  // getByTestId() already reads the configured attribute, so only the other attributes need a helper.
  if (attribute === config.testIdAttribute) return { code: `page.getByTestId(${quote(value)})`, source };
  if (attribute === "data-testid") return { code: `byTestId(page, ${quote(value)})`, source };
  if (attribute === "data-qa") return { code: `byQa(page, ${quote(value)})`, source };
  return { code: `byEnvId(page, ${quote(value)})`, source };
}

/**
 * Chooses the most stable locator for an element:
 * data-testid > data-qa > data-{ID_SELECTOR} > role+name > label > placeholder > text.
 * Returns undefined when nothing identifies the element (it is then not worth listing).
 */
export function chooseLocator(
  element: RawElement,
  config: SelectorConfig,
): { code: string; source: SelectorSource; attribute?: string } | undefined {
  for (const attribute of stableAttributes(config.idSelector)) {
    const value = element.attrs[attribute]?.trim();
    if (value) return { ...attributeLocator(attribute, value, config), attribute };
  }
  if (element.role && element.name) return { code: `page.getByRole(${quote(element.role)}, { name: ${quote(element.name)} })`, source: "role" };
  // Form controls without an ARIA role (e.g. file inputs, password fields) are still found by their label or aria-label.
  if (element.name && element.name !== element.placeholder && ["input", "select", "textarea"].includes(element.tag) && !element.label) {
    return { code: `page.getByLabel(${quote(element.name)})`, source: "label" };
  }
  if (element.label) return { code: `page.getByLabel(${quote(element.label)})`, source: "label" };
  if (element.placeholder) return { code: `page.getByPlaceholder(${quote(element.placeholder)})`, source: "placeholder" };
  if (element.text) return { code: `page.getByText(${quote(element.text)}, { exact: true })`, source: "text" };
  return undefined;
}

export interface ElementSummary {
  elements: InspectedElement[];
  /** Elements that could be identified, before the maxElements limit. */
  total: number;
  truncated: boolean;
  ambiguousCount: number;
}

/** Maps raw elements to locators, merges elements with the same locator and flags ambiguous ones. */
export function summarizeElements(raw: RawElement[], config: SelectorConfig, maxElements: number): ElementSummary {
  const byLocator = new Map<string, InspectedElement>();
  for (const element of raw) {
    const chosen = chooseLocator(element, config);
    if (!chosen) continue;
    const existing = byLocator.get(chosen.code);
    if (existing) {
      existing.count = (existing.count ?? 1) + 1;
      existing.ambiguous = true;
      continue;
    }
    byLocator.set(chosen.code, {
      tag: element.tag,
      ...(element.role ? { role: element.role } : {}),
      ...(element.name ? { name: element.name } : {}),
      ...(element.type ? { type: element.type } : {}),
      locator: chosen.code,
      source: chosen.source,
      ...(chosen.attribute ? { attribute: chosen.attribute } : {}),
      ...(element.href ? { href: element.href } : {}),
      ...(element.disabled ? { disabled: true } : {}),
      ...(element.required ? { required: true } : {}),
      ...(element.checked ? { checked: true } : {}),
    });
  }
  const all = [...byLocator.values()];
  return {
    elements: all.slice(0, maxElements),
    total: all.length,
    truncated: all.length > maxElements,
    ambiguousCount: all.filter((element) => element.ambiguous).length,
  };
}
