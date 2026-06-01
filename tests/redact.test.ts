import { describe, expect, it, beforeEach } from "@jest/globals";

import {
  redactActionData,
  redactFormData,
  hydrateRedactedTokens,
  type RedactSentinel,
} from "../dom/redact";

// Minimal in-memory Storage stand-in so tests don't depend on jsdom's
// localStorage and can assert exactly what was written.
class FakeStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(i: number) {
    return Array.from(this.map.keys())[i] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

// A storage whose setItem always throws (quota exceeded / disabled).
class ThrowingStorage extends FakeStorage {
  setItem(): void {
    throw new Error("QuotaExceededError");
  }
}

describe("redactActionData", () => {
  let storage: FakeStorage;
  beforeEach(() => {
    storage = new FakeStorage();
    document.body.innerHTML = "";
  });

  it("persists the value and replaces it with a sentinel (single tagged input)", () => {
    const input = document.createElement("input");
    input.setAttribute("name", "passport");
    input.setAttribute("data-lvt-redact", "passport");
    input.value = "X1234567";

    const data: Record<string, unknown> = { passport: "X1234567" };
    redactActionData(input, data, { storage, scope: "s1" });

    expect(storage.getItem("lvt-redact:s1:passport")).toBe("X1234567");
    expect(data.passport).toEqual({ redacted: true, field: "passport" } as RedactSentinel);
  });

  it("redacts tagged descendants on the form-submit path", () => {
    const form = document.createElement("form");
    form.innerHTML = `
      <input name="name" value="Ada" />
      <input name="ssn" data-lvt-redact="ssn" value="111-22-3333" />
    `;

    const data: Record<string, unknown> = { name: "Ada", ssn: "111-22-3333" };
    redactActionData(form, data, { storage, scope: "s1" });

    // Non-tagged field is untouched.
    expect(data.name).toBe("Ada");
    // Tagged field is redacted + stored.
    expect(data.ssn).toEqual({ redacted: true, field: "ssn" });
    expect(storage.getItem("lvt-redact:s1:ssn")).toBe("111-22-3333");
  });

  it("uses the redact field name as the payload key when name is absent", () => {
    const input = document.createElement("input");
    input.setAttribute("data-lvt-redact", "tax_id");
    input.value = "42";

    const data: Record<string, unknown> = { value: "42" };
    redactActionData(input, data, { storage, scope: "s1" });

    expect(data.tax_id).toEqual({ redacted: true, field: "tax_id" });
    expect(storage.getItem("lvt-redact:s1:tax_id")).toBe("42");
  });

  it("is a no-op when no element is tagged", () => {
    const input = document.createElement("input");
    input.setAttribute("name", "plain");
    input.value = "visible";

    const data: Record<string, unknown> = { plain: "visible" };
    redactActionData(input, data, { storage, scope: "s1" });

    expect(data.plain).toBe("visible");
    expect(storage.length).toBe(0);
  });

  it("drops the raw value rather than leaking it when storage.setItem throws", () => {
    const input = document.createElement("input");
    input.setAttribute("name", "passport");
    input.setAttribute("data-lvt-redact", "passport");
    input.value = "secret";

    const data: Record<string, unknown> = { passport: "secret" };
    redactActionData(input, data, { storage: new ThrowingStorage(), scope: "s1" });

    // The secret must never survive in the payload, even if persistence failed.
    expect(data.passport).toEqual({ redacted: true, field: "passport" });
  });

  it("redacts even when localStorage is entirely unavailable (fail-closed)", () => {
    // Simulate a browser where localStorage is absent (disabled storage /
    // sandboxed iframe): getStorage() sees no global and returns null. The raw
    // value must still be dropped from the payload rather than leaked.
    const desc = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: undefined,
    });
    try {
      const input = document.createElement("input");
      input.setAttribute("name", "passport");
      input.setAttribute("data-lvt-redact", "passport");
      input.value = "secret";

      const data: Record<string, unknown> = { passport: "secret" };
      redactActionData(input, data); // no opts -> falls back to (absent) global

      expect(data.passport).toEqual({ redacted: true, field: "passport" });
    } finally {
      if (desc) Object.defineProperty(globalThis, "localStorage", desc);
    }
  });

  it("resolves the scope from the page's data-lvt-id when none is given", () => {
    document.body.innerHTML = `<div data-lvt-id="page-xyz"></div>`;
    const input = document.createElement("input");
    input.setAttribute("name", "passport");
    input.setAttribute("data-lvt-redact", "passport");
    input.value = "Z9";
    document.body.querySelector("[data-lvt-id]")!.appendChild(input);

    const data: Record<string, unknown> = { passport: "Z9" };
    redactActionData(input, data, { storage });

    expect(storage.getItem("lvt-redact:page-xyz:passport")).toBe("Z9");
  });
});

describe("redactFormData", () => {
  let storage: FakeStorage;
  beforeEach(() => {
    storage = new FakeStorage();
    document.body.innerHTML = "";
  });

  it("replaces the tagged field in FormData with a JSON sentinel and stores the raw value", () => {
    const form = document.createElement("form");
    form.innerHTML = `
      <input name="note" value="trip" />
      <input name="passport" data-lvt-redact="passport" value="X1234567" />
      <input type="file" name="doc" />
    `;
    const fd = new FormData();
    fd.set("note", "trip");
    fd.set("passport", "X1234567");

    redactFormData(form, fd, { storage, scope: "s1" });

    // The raw value is gone from the multipart payload.
    expect(fd.get("passport")).toBe(JSON.stringify({ redacted: true, field: "passport" }));
    // The non-redacted field is untouched.
    expect(fd.get("note")).toBe("trip");
    // The raw value is preserved in localStorage.
    expect(storage.getItem("lvt-redact:s1:passport")).toBe("X1234567");
  });

  it("never leaves the raw value anywhere in the serialized multipart body", () => {
    const form = document.createElement("form");
    form.innerHTML = `<input name="passport" data-lvt-redact="passport" value="SECRET-999" />`;
    const fd = new FormData();
    fd.set("passport", "SECRET-999");

    redactFormData(form, fd, { storage, scope: "s1" });

    // Walk every entry — the raw value must appear in none of them.
    for (const [, value] of fd.entries()) {
      expect(String(value)).not.toContain("SECRET-999");
    }
  });

  it("drops the raw value even when storage.setItem throws", () => {
    const form = document.createElement("form");
    form.innerHTML = `<input name="passport" data-lvt-redact="passport" value="secret" />`;
    const fd = new FormData();
    fd.set("passport", "secret");

    redactFormData(form, fd, { storage: new ThrowingStorage(), scope: "s1" });

    expect(fd.get("passport")).toBe(JSON.stringify({ redacted: true, field: "passport" }));
  });

  it("is a no-op when no field is tagged", () => {
    const form = document.createElement("form");
    form.innerHTML = `<input name="plain" value="visible" />`;
    const fd = new FormData();
    fd.set("plain", "visible");

    redactFormData(form, fd, { storage, scope: "s1" });

    expect(fd.get("plain")).toBe("visible");
    expect(storage.length).toBe(0);
  });
});

describe("hydrateRedactedTokens", () => {
  let storage: FakeStorage;
  beforeEach(() => {
    storage = new FakeStorage();
    document.body.innerHTML = "";
  });

  it("substitutes stored values into tagged input elements", () => {
    storage.setItem("lvt-redact:s1:passport", "X1234567");
    const root = document.createElement("div");
    root.innerHTML = `<input name="passport" data-lvt-redact="passport" value="" />`;
    document.body.appendChild(root);

    hydrateRedactedTokens(root, { storage, scope: "s1" });

    expect(root.querySelector("input")!.value).toBe("X1234567");
  });

  it("fills textContent of a tagged non-input element (the lvt.Redact span)", () => {
    storage.setItem("lvt-redact:s1:passport", "X1234567");
    const root = document.createElement("div");
    root.innerHTML = `<span data-lvt-redact="passport"></span>`;
    document.body.appendChild(root);

    hydrateRedactedTokens(root, { storage, scope: "s1" });

    expect(root.querySelector("span")!.textContent).toBe("X1234567");
  });

  it("fills multiple distinct tagged elements in one pass", () => {
    storage.setItem("lvt-redact:s1:first", "Ada");
    storage.setItem("lvt-redact:s1:last", "Lovelace");
    const root = document.createElement("div");
    root.innerHTML =
      `<span data-lvt-redact="first"></span> <span data-lvt-redact="last"></span>`;
    document.body.appendChild(root);

    hydrateRedactedTokens(root, { storage, scope: "s1" });

    const spans = root.querySelectorAll("span");
    expect(spans[0].textContent).toBe("Ada");
    expect(spans[1].textContent).toBe("Lovelace");
  });

  it("leaves a tagged element empty when no value is stored", () => {
    const root = document.createElement("div");
    root.innerHTML = `<span data-lvt-redact="unknown"></span>`;
    document.body.appendChild(root);

    hydrateRedactedTokens(root, { storage, scope: "s1" });

    expect(root.querySelector("span")!.textContent).toBe("");
  });

  it("escapes substituted values as text, never as HTML (no XSS)", () => {
    // A stored value containing markup must land as literal text (textContent),
    // not be parsed as DOM.
    storage.setItem("lvt-redact:s1:bio", "<img src=x onerror=alert(1)>");
    const root = document.createElement("div");
    root.innerHTML = `<span data-lvt-redact="bio"></span>`;
    document.body.appendChild(root);

    hydrateRedactedTokens(root, { storage, scope: "s1" });

    const span = root.querySelector("span")!;
    expect(span.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(span.querySelector("img")).toBeNull();
  });

  it("does NOT substitute token-looking text without the attribute (no free scan)", () => {
    // The security guarantee: only elements carrying data-lvt-redact are filled.
    // User-posted content that merely names a field must never trigger
    // substitution of the viewer's stored value.
    storage.setItem("lvt-redact:s1:passport", "X1234567");
    const root = document.createElement("div");
    root.innerHTML = `<span>my passport is [[passport]] and {{passport}}</span>`;
    document.body.appendChild(root);

    hydrateRedactedTokens(root, { storage, scope: "s1" });

    const text = root.querySelector("span")!.textContent!;
    expect(text).toBe("my passport is [[passport]] and {{passport}}");
    expect(text).not.toContain("X1234567");
  });

  it("skips the element the user is currently editing", () => {
    storage.setItem("lvt-redact:s1:passport", "STORED");
    const root = document.createElement("div");
    root.innerHTML = `<input name="passport" data-lvt-redact="passport" value="typing" />`;
    document.body.appendChild(root);
    const input = root.querySelector("input")!;
    input.focus();

    hydrateRedactedTokens(root, { storage, scope: "s1" });

    // Focused element keeps the user's in-progress value, not the stored one.
    expect(input.value).toBe("typing");
  });
});
