import { debounce } from "../utils/rate-limit";
import { DEFAULT_CHANGE_DEBOUNCE_MS } from "../constants";
import type { TreeNode } from "../types";
import type { Logger } from "../utils/logger";

export type BindingType = "value" | "content" | "attribute";

export interface ChangeMessage {
  action: "change";
  data: Record<string, string | boolean>;
}

export interface ChangeAutoWirerContext {
  getWrapperElement(): Element | null;
  send(message: ChangeMessage): void;
}

/**
 * Analyzes template statics to detect form fields with dynamic values,
 * then auto-wires debounced input event listeners when the server
 * declares "change" capability.
 */
export class ChangeAutoWirer {
  private boundFields: Map<string, BindingType> = new Map();
  private enabled: boolean = false;
  private wiredElements: WeakSet<Element> = new WeakSet();
  private elementCleanups: Map<Element, () => void> = new Map();

  constructor(
    private readonly context: ChangeAutoWirerContext,
    private readonly logger: Logger
  ) {}

  setCapabilities(capabilities: string[]): void {
    this.enabled = capabilities.includes("change");
    this.logger.debug(
      "Capabilities received, change auto-wiring:",
      this.enabled ? "enabled" : "disabled"
    );
  }

  analyzeStatics(treeState: TreeNode): void {
    this.boundFields.clear();
    this.walkTree(treeState);
    if (this.boundFields.size > 0) {
      this.logger.debug(
        `Detected ${this.boundFields.size} bound field(s):`,
        Array.from(this.boundFields.keys())
      );
    }
  }

  wireElements(): void {
    if (!this.enabled || this.boundFields.size === 0) return;

    const wrapper = this.context.getWrapperElement();
    if (!wrapper) return;

    // Evict stale entries for elements removed by morphdom
    for (const el of this.elementCleanups.keys()) {
      if (!el.isConnected) {
        this.elementCleanups.get(el)!();
        this.elementCleanups.delete(el);
      }
    }

    for (const [fieldName, bindingType] of this.boundFields) {
      const escapedName = this.escapeCSSSelector(fieldName);
      const elements = wrapper.querySelectorAll(`[name="${escapedName}"]`);

      for (const el of elements) {
        if (this.wiredElements.has(el)) continue;
        if (el.hasAttribute("lvt-input") || el.hasAttribute("lvt-change"))
          continue;

        const parentForm = el.closest("form");
        if (parentForm) {
          if (parentForm.hasAttribute("lvt-change")) continue;
          if (parentForm.hasAttribute("lvt-no-intercept")) continue;
        }

        if (el instanceof HTMLInputElement) {
          if (
            el.type === "hidden" ||
            el.type === "submit" ||
            el.type === "button"
          )
            continue;
        }
        if (el instanceof HTMLButtonElement) continue;

        this.attachListener(el as HTMLElement, fieldName, bindingType);
        this.wiredElements.add(el);
      }
    }
  }

  teardown(): void {
    for (const cleanup of this.elementCleanups.values()) {
      cleanup();
    }
    this.elementCleanups.clear();
    this.wiredElements = new WeakSet();
    this.boundFields.clear();
    this.enabled = false;
  }

  getBoundFields(): Map<string, BindingType> {
    return this.boundFields;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private walkTree(node: any): void {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;

    if (node.s && Array.isArray(node.s)) {
      this.analyzeStaticsArray(node.s);
    }

    for (const key of Object.keys(node)) {
      if (/^\d+$/.test(key)) {
        const child = node[key];
        if (child && typeof child === "object" && !Array.isArray(child)) {
          this.walkTree(child);
        }
      }
    }

    if (node.d && Array.isArray(node.d)) {
      for (const item of node.d) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          this.walkTree(item);
        }
      }
    }
  }

  private analyzeStaticsArray(statics: string[]): void {
    for (let i = 0; i < statics.length - 1; i++) {
      const left = statics[i];
      const right = statics[i + 1];

      const binding = this.detectBinding(left, right);
      if (binding && !this.boundFields.has(binding.fieldName)) {
        this.boundFields.set(binding.fieldName, binding.bindingType);
      }
    }
  }

  private detectBinding(
    left: string,
    right: string
  ): { fieldName: string; bindingType: BindingType } | null {
    let fieldName = this.detectValueBinding(left);
    if (fieldName) {
      return { fieldName, bindingType: "value" };
    }

    fieldName = this.detectTextareaBinding(left, right);
    if (fieldName) {
      return { fieldName, bindingType: "content" };
    }

    fieldName = this.detectAttributeBinding(left, right);
    if (fieldName) {
      return { fieldName, bindingType: "attribute" };
    }

    return null;
  }

  /**
   * Extract the unclosed tag fragment at the end of a static string.
   * Returns null if the string does not end inside an open tag.
   */
  /**
   * Escape a string for use in a CSS attribute selector.
   * Uses CSS.escape when available (browsers), falls back to manual escaping.
   */
  private escapeCSSSelector(value: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  private extractUnclosedTag(text: string): string | null {
    const lastOpen = text.lastIndexOf("<");
    const lastClose = text.lastIndexOf(">");
    if (lastOpen === -1 || lastOpen <= lastClose) return null;
    return text.substring(lastOpen);
  }

  private extractNameFromTag(partialTag: string): string | null {
    const match = partialTag.match(/\sname="([^"]+)"/);
    return match ? match[1] : null;
  }

  /** Detects: <input name="X" ... value="{{.X}}"> */
  private detectValueBinding(left: string): string | null {
    if (!left.endsWith('value="')) return null;
    const partialTag = this.extractUnclosedTag(left);
    if (!partialTag) return null;
    return this.extractNameFromTag(partialTag);
  }

  /** Detects: <textarea name="X">{{.X}}</textarea> */
  private detectTextareaBinding(left: string, right: string): string | null {
    if (!right.startsWith("</textarea")) return null;
    const tagMatch = left.match(/<textarea[^>]*\sname="([^"]+)"[^>]*>$/);
    return tagMatch ? tagMatch[1] : null;
  }

  /** Detects: <input name="X" {{if .X}}checked{{end}}> */
  private detectAttributeBinding(left: string, right: string): string | null {
    if (!left.endsWith(" ")) return null;
    if (!/^[a-zA-Z>/\s]/.test(right)) return null;

    const partialTag = this.extractUnclosedTag(left);
    if (!partialTag) return null;
    if (!/^<(input|select|option)\s/i.test(partialTag)) return null;

    return this.extractNameFromTag(partialTag);
  }

  private attachListener(
    element: HTMLElement,
    fieldName: string,
    bindingType: BindingType
  ): void {
    const customDebounce = element.getAttribute("lvt-debounce");
    const parsed = customDebounce ? parseInt(customDebounce, 10) : NaN;
    const wait = Number.isNaN(parsed) ? DEFAULT_CHANGE_DEBOUNCE_MS : parsed;

    const sendChange = () => {
      if (!this.enabled) return;

      const value: string | boolean =
        bindingType === "attribute"
          ? (element as HTMLInputElement).checked
          : (element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)
              .value;

      this.context.send({
        action: "change",
        data: { [fieldName]: value },
      });
    };

    const debouncedSend = debounce(sendChange, wait);

    // Discrete events (checkbox toggle, select change) use 'change';
    // continuous typing uses 'input'
    const eventType =
      bindingType === "attribute" || element instanceof HTMLSelectElement
        ? "change"
        : "input";

    element.addEventListener(eventType, debouncedSend);

    this.elementCleanups.set(element, () => {
      element.removeEventListener(eventType, debouncedSend);
    });

    this.logger.debug(
      `Auto-wired ${eventType} listener on [name="${fieldName}"] (debounce: ${wait}ms)`
    );
  }
}
