import {
  setupHashLink,
  teardownHashLink,
  openFromHash,
  isHashLinkTarget,
  activateHashTarget,
} from "../dom/hash-link";

function mockDialogMethods(dialog: HTMLDialogElement): {
  showModal: jest.Mock;
  close: jest.Mock;
} {
  const showModal = jest.fn(() => {
    dialog.setAttribute("open", "");
  });
  const close = jest.fn(() => {
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
  });
  (dialog as any).showModal = showModal;
  (dialog as any).close = close;
  return { showModal, close };
}

function createDialog(id: string): {
  dialog: HTMLDialogElement;
  showModal: jest.Mock;
  close: jest.Mock;
} {
  const dialog = document.createElement("dialog");
  dialog.id = id;
  const mocks = mockDialogMethods(dialog);
  document.body.appendChild(dialog);
  return { dialog, ...mocks };
}

function createDetails(id: string): HTMLDetailsElement {
  const details = document.createElement("details");
  details.id = id;
  const summary = document.createElement("summary");
  summary.textContent = "Toggle";
  details.appendChild(summary);
  document.body.appendChild(details);
  return details;
}

function createInvokerButton(
  command: string,
  targetId: string
): HTMLButtonElement {
  const button = document.createElement("button");
  button.setAttribute("command", command);
  button.setAttribute("commandfor", targetId);
  document.body.appendChild(button);
  return button;
}

function clearDOM(): void {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
}

describe("hash-link", () => {
  let pushStateSpy: jest.SpyInstance;
  let replaceStateSpy: jest.SpyInstance;

  beforeEach(() => {
    clearDOM();
    history.replaceState(null, "", location.pathname);
    pushStateSpy = jest.spyOn(history, "pushState");
    replaceStateSpy = jest.spyOn(history, "replaceState");
  });

  afterEach(() => {
    teardownHashLink();
    pushStateSpy.mockRestore();
    replaceStateSpy.mockRestore();
    clearDOM();
    history.replaceState(null, "", location.pathname);
  });

  describe("openFromHash", () => {
    it("opens a dialog when hash matches its ID", () => {
      history.replaceState(null, "", "#my-dialog");
      const { showModal } = createDialog("my-dialog");

      openFromHash();

      expect(showModal).toHaveBeenCalled();
    });

    it("no-ops when hash is empty", () => {
      const { showModal } = createDialog("my-dialog");

      openFromHash();

      expect(showModal).not.toHaveBeenCalled();
    });

    it("no-ops when hash matches a non-activatable element", () => {
      history.replaceState(null, "", "#my-div");
      const div = document.createElement("div");
      div.id = "my-div";
      document.body.appendChild(div);

      openFromHash();
    });

    it("no-ops when hash matches no element", () => {
      history.replaceState(null, "", "#nonexistent");

      openFromHash();
    });

    it("no-ops when dialog is already open", () => {
      history.replaceState(null, "", "#my-dialog");
      const { dialog, showModal } = createDialog("my-dialog");
      dialog.setAttribute("open", "");

      openFromHash();

      expect(showModal).not.toHaveBeenCalled();
    });

    it("opens a details element when hash matches", () => {
      history.replaceState(null, "", "#my-details");
      const details = createDetails("my-details");

      openFromHash();

      expect(details.open).toBe(true);
    });
  });

  describe("isHashLinkTarget", () => {
    it("returns true for a dialog element", () => {
      createDialog("dlg");
      expect(isHashLinkTarget("dlg")).toBe(true);
    });

    it("returns true for a details element", () => {
      createDetails("det");
      expect(isHashLinkTarget("det")).toBe(true);
    });

    it("returns false for a plain div", () => {
      const div = document.createElement("div");
      div.id = "section";
      document.body.appendChild(div);
      expect(isHashLinkTarget("section")).toBe(false);
    });

    it("returns false for nonexistent element", () => {
      expect(isHashLinkTarget("nope")).toBe(false);
    });
  });

  describe("activateHashTarget", () => {
    it("pushes hash and opens a dialog", () => {
      const { showModal } = createDialog("dlg");

      activateHashTarget("dlg");

      expect(pushStateSpy).toHaveBeenCalledWith(null, "", "#dlg");
      expect(showModal).toHaveBeenCalled();
    });

    it("no-ops for non-activatable elements", () => {
      const div = document.createElement("div");
      div.id = "section";
      document.body.appendChild(div);

      activateHashTarget("section");

      expect(pushStateSpy).not.toHaveBeenCalled();
    });

    it("no-ops when element is already open", () => {
      const { dialog } = createDialog("dlg");
      dialog.setAttribute("open", "");

      activateHashTarget("dlg");

      expect(pushStateSpy).not.toHaveBeenCalled();
    });
  });

  describe("click listener (invoker buttons)", () => {
    it("pushes hash on show-modal button click", () => {
      createDialog("dlg");
      const button = createInvokerButton("show-modal", "dlg");

      setupHashLink();
      button.click();

      expect(pushStateSpy).toHaveBeenCalledWith(null, "", "#dlg");
    });

    it("pushes hash on show-popover button click", () => {
      const div = document.createElement("div");
      div.id = "pop";
      div.setAttribute("popover", "");
      document.body.appendChild(div);
      const button = createInvokerButton("show-popover", "pop");

      setupHashLink();
      button.click();

      expect(pushStateSpy).toHaveBeenCalledWith(null, "", "#pop");
    });

    it("pushes hash on toggle-popover when element is closed", () => {
      const div = document.createElement("div");
      div.id = "pop";
      div.setAttribute("popover", "");
      document.body.appendChild(div);
      const button = createInvokerButton("toggle-popover", "pop");

      setupHashLink();
      button.click();

      expect(pushStateSpy).toHaveBeenCalledWith(null, "", "#pop");
    });

    it("does not push hash for close command", () => {
      createDialog("dlg");
      const button = createInvokerButton("close", "dlg");

      setupHashLink();
      button.click();

      expect(pushStateSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "#dlg"
      );
    });

    it("does not push hash on disabled button", () => {
      createDialog("dlg");
      const button = createInvokerButton("show-modal", "dlg");
      button.disabled = true;

      setupHashLink();
      button.click();

      expect(pushStateSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "#dlg"
      );
    });

    it("does not push duplicate hash", () => {
      createDialog("dlg");
      const button = createInvokerButton("show-modal", "dlg");
      history.replaceState(null, "", "#dlg");

      setupHashLink();
      pushStateSpy.mockClear();
      button.click();

      expect(pushStateSpy).not.toHaveBeenCalled();
    });

    it("does not push hash for non-activatable targets", () => {
      const div = document.createElement("div");
      div.id = "section";
      document.body.appendChild(div);
      const button = createInvokerButton("show-modal", "section");

      setupHashLink();
      button.click();

      expect(pushStateSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        "#section"
      );
    });
  });

  describe("close event listener", () => {
    it("clears hash when dialog closes and hash matches", () => {
      const { dialog } = createDialog("dlg");
      dialog.setAttribute("open", "");
      history.replaceState(null, "", "#dlg");

      setupHashLink();
      replaceStateSpy.mockClear();

      dialog.dispatchEvent(new Event("close"));

      expect(replaceStateSpy).toHaveBeenCalledWith(
        null,
        "",
        location.pathname + location.search
      );
    });

    it("does not clear hash when hash does not match closing dialog", () => {
      const { dialog } = createDialog("dlg");
      dialog.setAttribute("open", "");
      history.replaceState(null, "", "#other");

      setupHashLink();
      replaceStateSpy.mockClear();

      dialog.dispatchEvent(new Event("close"));

      expect(replaceStateSpy).not.toHaveBeenCalled();
    });

    it("does not clear hash for non-activatable elements", () => {
      const div = document.createElement("div");
      div.id = "section";
      document.body.appendChild(div);
      history.replaceState(null, "", "#section");

      setupHashLink();
      replaceStateSpy.mockClear();

      div.dispatchEvent(new Event("close"));

      expect(replaceStateSpy).not.toHaveBeenCalled();
    });
  });

  describe("toggle event listener", () => {
    it("pushes hash when details opens", () => {
      const details = createDetails("faq");

      setupHashLink();
      details.open = true;
      details.dispatchEvent(new Event("toggle"));

      expect(pushStateSpy).toHaveBeenCalledWith(null, "", "#faq");
    });

    it("clears hash when details closes", () => {
      const details = createDetails("faq");
      history.replaceState(null, "", "#faq");

      setupHashLink();
      replaceStateSpy.mockClear();

      details.open = false;
      details.dispatchEvent(new Event("toggle"));

      expect(replaceStateSpy).toHaveBeenCalledWith(
        null,
        "",
        location.pathname + location.search
      );
    });

    it("does not push hash when details opens but hash already matches", () => {
      const details = createDetails("faq");
      history.replaceState(null, "", "#faq");

      setupHashLink();
      pushStateSpy.mockClear();

      details.open = true;
      details.dispatchEvent(new Event("toggle"));

      expect(pushStateSpy).not.toHaveBeenCalled();
    });
  });

  describe("popstate reconciliation", () => {
    it("closes open dialog when hash changes away", () => {
      const { dialog, close } = createDialog("dlg");
      dialog.setAttribute("open", "");

      setupHashLink();
      history.replaceState(null, "", location.pathname);
      window.dispatchEvent(new PopStateEvent("popstate"));

      expect(close).toHaveBeenCalled();
    });

    it("opens dialog when hash changes to match", () => {
      const { showModal } = createDialog("dlg");

      setupHashLink();
      history.replaceState(null, "", "#dlg");
      window.dispatchEvent(new PopStateEvent("popstate"));

      expect(showModal).toHaveBeenCalled();
    });

    it("self-guards: close event during popstate does not call replaceState", () => {
      const { dialog, close } = createDialog("dlg");
      dialog.setAttribute("open", "");
      history.replaceState(null, "", "#dlg");

      setupHashLink();
      replaceStateSpy.mockClear();

      history.replaceState(null, "", location.pathname);
      window.dispatchEvent(new PopStateEvent("popstate"));

      expect(close).toHaveBeenCalled();
      expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("teardown", () => {
    it("removes all listeners", () => {
      createDialog("dlg");
      const button = createInvokerButton("show-modal", "dlg");

      setupHashLink();
      teardownHashLink();
      pushStateSpy.mockClear();

      button.click();
      expect(pushStateSpy).not.toHaveBeenCalled();
    });

    it("is idempotent", () => {
      setupHashLink();
      teardownHashLink();
      teardownHashLink();
    });
  });

  describe("setup", () => {
    it("calls openFromHash on setup", () => {
      history.replaceState(null, "", "#dlg");
      const { showModal } = createDialog("dlg");

      setupHashLink();

      expect(showModal).toHaveBeenCalled();
    });

    it("is idempotent", () => {
      history.replaceState(null, "", "#dlg");
      const { showModal } = createDialog("dlg");

      setupHashLink();
      setupHashLink();

      expect(showModal).toHaveBeenCalledTimes(1);
    });
  });
});
