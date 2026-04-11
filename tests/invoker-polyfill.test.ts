import { setupInvokerPolyfill, teardownInvokerPolyfill } from "../dom/invoker-polyfill";

/**
 * jsdom does not implement HTMLDialogElement.showModal() or .close().
 * Add mock implementations to a dialog element for testing.
 */
function mockDialogMethods(dialog: HTMLDialogElement): {
  showModal: jest.Mock;
  close: jest.Mock;
} {
  const showModal = jest.fn(() => {
    dialog.setAttribute("open", "");
  });
  const close = jest.fn(() => {
    dialog.removeAttribute("open");
  });
  (dialog as any).showModal = showModal;
  (dialog as any).close = close;
  return { showModal, close };
}

describe("setupInvokerPolyfill", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    teardownInvokerPolyfill();
    document.body.innerHTML = "";
  });

  it("show-modal opens a closed dialog", () => {
    const dialog = document.createElement("dialog");
    dialog.id = "test-dialog";
    const { showModal } = mockDialogMethods(dialog);
    document.body.appendChild(dialog);

    const button = document.createElement("button");
    button.setAttribute("command", "show-modal");
    button.setAttribute("commandfor", "test-dialog");
    document.body.appendChild(button);

    setupInvokerPolyfill();
    button.click();

    expect(showModal).toHaveBeenCalled();
    expect(dialog.open).toBe(true);
  });

  it("close closes an open dialog", () => {
    const dialog = document.createElement("dialog");
    dialog.id = "test-dialog";
    dialog.setAttribute("open", "");
    const { close } = mockDialogMethods(dialog);
    document.body.appendChild(dialog);

    const button = document.createElement("button");
    button.setAttribute("command", "close");
    button.setAttribute("commandfor", "test-dialog");
    document.body.appendChild(button);

    setupInvokerPolyfill();
    button.click();

    expect(close).toHaveBeenCalled();
    expect(dialog.open).toBe(false);
  });

  it("ignores buttons without commandfor", () => {
    const dialog = document.createElement("dialog");
    dialog.id = "test-dialog";
    const { showModal } = mockDialogMethods(dialog);
    document.body.appendChild(dialog);

    const button = document.createElement("button");
    button.setAttribute("command", "show-modal");
    document.body.appendChild(button);

    setupInvokerPolyfill();
    button.click();

    expect(showModal).not.toHaveBeenCalled();
  });

  it("ignores non-dialog targets", () => {
    const div = document.createElement("div");
    div.id = "not-a-dialog";
    document.body.appendChild(div);

    const button = document.createElement("button");
    button.setAttribute("command", "show-modal");
    button.setAttribute("commandfor", "not-a-dialog");
    document.body.appendChild(button);

    setupInvokerPolyfill();

    expect(() => button.click()).not.toThrow();
  });

  it("ignores nonexistent targets", () => {
    const button = document.createElement("button");
    button.setAttribute("command", "show-modal");
    button.setAttribute("commandfor", "nonexistent");
    document.body.appendChild(button);

    setupInvokerPolyfill();

    expect(() => button.click()).not.toThrow();
  });

  it("ignores disabled buttons", () => {
    const dialog = document.createElement("dialog");
    dialog.id = "test-dialog";
    const { showModal } = mockDialogMethods(dialog);
    document.body.appendChild(dialog);

    const button = document.createElement("button");
    button.setAttribute("command", "show-modal");
    button.setAttribute("commandfor", "test-dialog");
    button.disabled = true;
    document.body.appendChild(button);

    setupInvokerPolyfill();
    button.click();

    expect(showModal).not.toHaveBeenCalled();
  });

  it("does not call showModal on already-open dialog", () => {
    const dialog = document.createElement("dialog");
    dialog.id = "test-dialog";
    dialog.setAttribute("open", "");
    const { showModal } = mockDialogMethods(dialog);
    document.body.appendChild(dialog);

    const button = document.createElement("button");
    button.setAttribute("command", "show-modal");
    button.setAttribute("commandfor", "test-dialog");
    document.body.appendChild(button);

    setupInvokerPolyfill();
    button.click();

    expect(showModal).not.toHaveBeenCalled();
  });

  it("does not call close on already-closed dialog", () => {
    const dialog = document.createElement("dialog");
    dialog.id = "test-dialog";
    const { close } = mockDialogMethods(dialog);
    document.body.appendChild(dialog);

    const button = document.createElement("button");
    button.setAttribute("command", "close");
    button.setAttribute("commandfor", "test-dialog");
    document.body.appendChild(button);

    setupInvokerPolyfill();
    button.click();

    expect(close).not.toHaveBeenCalled();
  });

  it("handles clicks on child elements inside the button", () => {
    const dialog = document.createElement("dialog");
    dialog.id = "test-dialog";
    const { showModal } = mockDialogMethods(dialog);
    document.body.appendChild(dialog);

    const button = document.createElement("button");
    button.setAttribute("command", "show-modal");
    button.setAttribute("commandfor", "test-dialog");
    const icon = document.createElement("span");
    icon.textContent = "+";
    button.appendChild(icon);
    document.body.appendChild(button);

    setupInvokerPolyfill();

    // Click the child <span>, not the button directly
    icon.click();

    expect(showModal).toHaveBeenCalled();
  });

  it("skips polyfill when native support exists", () => {
    // Simulate native support by adding commandForElement to prototype
    Object.defineProperty(HTMLButtonElement.prototype, "commandForElement", {
      value: null,
      writable: true,
      configurable: true,
    });

    const dialog = document.createElement("dialog");
    dialog.id = "test-dialog";
    const { showModal } = mockDialogMethods(dialog);
    document.body.appendChild(dialog);

    const button = document.createElement("button");
    button.setAttribute("command", "show-modal");
    button.setAttribute("commandfor", "test-dialog");
    document.body.appendChild(button);

    setupInvokerPolyfill();
    button.click();

    // Polyfill should not have installed its listener
    expect(showModal).not.toHaveBeenCalled();

    // Clean up the mock property
    delete (HTMLButtonElement.prototype as any).commandForElement;
  });

  it("ignores unknown commands", () => {
    const dialog = document.createElement("dialog");
    dialog.id = "test-dialog";
    const { showModal, close } = mockDialogMethods(dialog);
    document.body.appendChild(dialog);

    const button = document.createElement("button");
    button.setAttribute("command", "toggle-popover");
    button.setAttribute("commandfor", "test-dialog");
    document.body.appendChild(button);

    setupInvokerPolyfill();
    button.click();

    expect(showModal).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
