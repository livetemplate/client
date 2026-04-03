import type { ResponseMetadata } from "../types";

/**
 * Tracks form submission lifecycle for LiveTemplate actions.
 */
export class FormLifecycleManager {
  private activeForm: HTMLFormElement | null = null;
  private activeButton: HTMLButtonElement | null = null;
  private originalButtonText: string | null = null;

  constructor() {}

  setActiveSubmission(
    form: HTMLFormElement | null,
    button: HTMLButtonElement | null,
    originalButtonText: string | null
  ): void {
    this.activeForm = form;
    this.activeButton = button;
    this.originalButtonText = originalButtonText;

    // Auto aria-busy + fieldset disabled for loading states
    if (form) {
      form.setAttribute("aria-busy", "true");
      const fieldset = form.querySelector("fieldset");
      if (fieldset) {
        fieldset.disabled = true;
      }
    }
  }

  handleResponse(meta: ResponseMetadata): void {
    if (this.activeForm) {
      this.activeForm.dispatchEvent(
        new CustomEvent("lvt:done", { detail: meta })
      );
    }

    if (meta.success) {
      this.handleSuccess(meta);
    } else {
      this.handleError(meta);
    }

    this.restoreFormState();
  }

  reset(): void {
    this.restoreFormState();
  }

  private handleSuccess(meta: ResponseMetadata): void {
    if (!this.activeForm) {
      return;
    }

    this.activeForm.dispatchEvent(
      new CustomEvent("lvt:success", { detail: meta })
    );

    // Close parent <dialog> using native API instead of ModalManager
    const dialogParent = this.activeForm.closest("dialog");
    if (dialogParent && dialogParent.open) {
      dialogParent.close();
    }

    if (!this.activeForm.hasAttribute("lvt-form:preserve")) {
      this.activeForm.reset();
    }
  }

  private handleError(meta: ResponseMetadata): void {
    if (!this.activeForm) {
      return;
    }

    this.activeForm.dispatchEvent(
      new CustomEvent("lvt:error", { detail: meta })
    );
  }

  private restoreFormState(): void {
    if (this.activeForm) {
      this.activeForm.removeAttribute("aria-busy");
      const fieldset = this.activeForm.querySelector("fieldset");
      if (fieldset) {
        fieldset.disabled = false;
      }
    }

    if (this.activeButton && this.originalButtonText !== null) {
      this.activeButton.disabled = false;
      this.activeButton.textContent = this.originalButtonText;
    }

    this.activeForm = null;
    this.activeButton = null;
    this.originalButtonText = null;
  }
}
