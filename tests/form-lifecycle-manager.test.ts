import { FormLifecycleManager } from "../state/form-lifecycle-manager";
import type { ResponseMetadata } from "../types";

describe("FormLifecycleManager", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  const createForm = () => {
    const dialog = document.createElement("dialog");
    dialog.id = "dialog-1";
    // JSDOM doesn't implement dialog.showModal() — polyfill
    if (!dialog.showModal) {
      dialog.showModal = function () { this.setAttribute("open", ""); };
    }
    if (!dialog.close) {
      dialog.close = function () { this.removeAttribute("open"); };
    }

    const form = document.createElement("form");
    dialog.appendChild(form);

    const button = document.createElement("button");
    button.textContent = "Submit";
    form.appendChild(button);

    document.body.appendChild(dialog);
    dialog.showModal();

    return { form, button, dialog };
  };

  it("dispatches success events, resets the form, and closes the dialog on success", () => {
    const { form, button, dialog } = createForm();
    const manager = new FormLifecycleManager();

    const doneListener = jest.fn();
    const successListener = jest.fn();
    form.addEventListener("lvt:done", doneListener);
    form.addEventListener("lvt:success", successListener);

    manager.setActiveSubmission(form, button, "Submit");

    const metadata: ResponseMetadata = { success: true, errors: {} };
    manager.handleResponse(metadata);

    expect(doneListener).toHaveBeenCalledWith(expect.any(CustomEvent));
    expect(successListener).toHaveBeenCalledWith(expect.any(CustomEvent));
    expect(dialog.open).toBe(false);
    expect(form.elements.length).toBeGreaterThan(0);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Submit");
  });

  it("respects lvt-form:preserve and keeps the fields intact", () => {
    const { form, button } = createForm();
    form.setAttribute("lvt-form:preserve", "");

    const input = document.createElement("input");
    input.value = "Keep me";
    form.appendChild(input);

    const manager = new FormLifecycleManager();
    manager.setActiveSubmission(form, button, "Submit");

    const metadata: ResponseMetadata = { success: true, errors: {} };
    manager.handleResponse(metadata);

    expect(input.value).toBe("Keep me");
  });

  it("dispatches error events and keeps the form when the response fails", () => {
    const { form, button, dialog } = createForm();
    const manager = new FormLifecycleManager();

    const doneListener = jest.fn();
    const errorListener = jest.fn();
    form.addEventListener("lvt:done", doneListener);
    form.addEventListener("lvt:error", errorListener);

    manager.setActiveSubmission(form, button, "Submit");

    const metadata: ResponseMetadata = {
      success: false,
      errors: { title: "Required" },
    };
    manager.handleResponse(metadata);

    expect(doneListener).toHaveBeenCalledWith(expect.any(CustomEvent));
    expect(errorListener).toHaveBeenCalledWith(expect.any(CustomEvent));
    expect(dialog.open).toBe(true);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Submit");
  });

  it("reset simply clears active submission state", () => {
    const { form, button, dialog } = createForm();
    const manager = new FormLifecycleManager();

    manager.setActiveSubmission(form, button, "Submit");
    manager.reset();

    const metadata: ResponseMetadata = { success: true, errors: {} };
    manager.handleResponse(metadata);

    // Dialog should still be open since reset was called before handleResponse
    expect(dialog.open).toBe(true);
  });
});
