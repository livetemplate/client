/**
 * Registration paths that do not go through a render: the pre-load queue, the
 * connect pass, and `delegatedEvents`.
 *
 * Each exists because of a load-order fact, not a preference. An inline
 * `<script>` ignores `defer`, so it runs before the client and must queue; a
 * queued handler registers before any client exists, and a page load hydrates
 * without a changing render, so it must run at connect; and a custom element's
 * event reaches no server action unless the delegator listens for its type.
 */

import {
  attachRegistryRoot,
  detachRegistryRoot,
  getRegisteredAttributes,
  installAttributeQueue,
  registerAttribute,
  __resetRegistryForTesting,
  type AttributeHandler,
  type RegistryRoot,
  type SendFn,
} from "../attribute-registry";
import { EventDelegator, delegatedEventTypes, type EventDelegationContext } from "../dom/event-delegation";
import { createLogger } from "../utils/logger";

const noopSend: SendFn = () => {};
let warn: jest.SpyInstance;
let roots: RegistryRoot[] = [];

function makeWrapper(html: string, id = "lvt-test"): Element {
  document.body.innerHTML = `<div data-lvt-id="${id}">${html}</div>`;
  return document.body.firstElementChild as Element;
}

function attach(root: Element, extra: Partial<RegistryRoot> = {}): RegistryRoot {
  const r: RegistryRoot = { root: () => root, send: noopSend, ...extra };
  roots.push(r);
  attachRegistryRoot(r);
  return r;
}

beforeEach(() => {
  __resetRegistryForTesting();
  delete window.lvtAttributes;
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const r of roots) detachRegistryRoot(r);
  roots = [];
  warn.mockRestore();
  delete window.lvtAttributes;
  document.body.innerHTML = "";
});

describe("window.lvtAttributes queue", () => {
  const copy = (): AttributeHandler => ({ attribute: "lvt-x:copy", onElementAdded: () => {} });

  it("registers entries pushed before the client evaluated", () => {
    const handler = copy();
    (window.lvtAttributes ||= []).push(handler);
    installAttributeQueue();
    expect(getRegisteredAttributes()).toContain(handler);
  });

  it("registers entries pushed after install immediately", () => {
    installAttributeQueue();
    const handler = copy();
    (window.lvtAttributes ||= []).push(handler);
    expect(getRegisteredAttributes()).toContain(handler);
  });

  it("returns a running count from push, like Array#push", () => {
    (window.lvtAttributes ||= []).push(copy());
    installAttributeQueue();
    expect(window.lvtAttributes!.push({ attribute: "lvt-x:a", onElementAdded: () => {} })).toBe(2);
    expect(window.lvtAttributes!.push({ attribute: "lvt-x:b", onElementAdded: () => {} })).toBe(3);
  });

  it("does not register the queue twice if the bundle evaluates twice", () => {
    (window.lvtAttributes ||= []).push(copy());
    installAttributeQueue();
    installAttributeQueue();
    expect(getRegisteredAttributes()).toHaveLength(1);
  });
});

describe("connect pass", () => {
  it("runs a pre-connect declarative handler over SSR'd markup with no render", () => {
    const added = jest.fn();
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: added });
    attach(makeWrapper(`<button lvt-x:copy="https://a">Copy</button>`));
    expect(added).toHaveBeenCalledTimes(1);
  });

  it("is idempotent for declarative handlers across reconnects", () => {
    const added = jest.fn();
    registerAttribute({ attribute: "lvt-x:copy", onElementAdded: added });
    const root = makeWrapper(`<button lvt-x:copy="https://a">Copy</button>`);
    const r = attach(root);
    detachRegistryRoot(r);
    attachRegistryRoot(r);
    expect(added).toHaveBeenCalledTimes(1);
  });

  it("runs a low-level handler only when it opts in with runOnConnect", () => {
    const optedIn = jest.fn();
    const notOptedIn = jest.fn();
    registerAttribute({ name: "a", selectors: ["[a]"], runOnConnect: true, setup: optedIn });
    registerAttribute({ name: "b", selectors: ["[b]"], setup: notOptedIn });
    attach(makeWrapper(""));
    expect(optedIn).toHaveBeenCalledTimes(1);
    expect(notOptedIn).not.toHaveBeenCalled();
  });

  it("hands runOnConnect handlers the server channel when they asked for it", () => {
    const send = jest.fn();
    let seen: SendFn | undefined;
    registerAttribute({
      name: "dispatcher",
      selectors: ["[x]"],
      needsServerChannel: true,
      runOnConnect: true,
      setup: (ctx) => {
        seen = ctx.send;
      },
    });
    attach(makeWrapper(""), { send });
    expect(seen).toBe(send);
  });
});

describe("delegatedEvents", () => {
  function delegatorFor(wrapper: Element, send: jest.Mock): EventDelegator {
    const context: EventDelegationContext = {
      getWrapperElement: () => wrapper,
      getRateLimitedHandlers: () => new WeakMap(),
      parseValue: (value: string) => value,
      send,
      sendHTTPMultipart: jest.fn(),
      setActiveSubmission: jest.fn(),
      getWebSocketReadyState: () => 1,
      triggerPendingUploads: jest.fn(),
    };
    return new EventDelegator(context, createLogger({ scope: "test", level: "silent" }));
  }

  const widget = `<my-widget id="w" lvt-on:my-widget-change="Save"></my-widget>`;
  const fire = () =>
    document.getElementById("w")!.dispatchEvent(new CustomEvent("my-widget-change", { bubbles: true }));

  it("leaves a custom event unrouted until a handler declares it", () => {
    const send = jest.fn();
    delegatorFor(makeWrapper(widget), send).setupEventDelegation();
    fire();
    expect(send).not.toHaveBeenCalled();
  });

  it("routes lvt-on:<custom-event> once a handler declares delegatedEvents", () => {
    registerAttribute({
      attribute: "lvt-x:widget",
      delegatedEvents: ["my-widget-change"],
      onElementAdded: () => {},
    });
    const send = jest.fn();
    delegatorFor(makeWrapper(widget), send).setupEventDelegation();
    fire();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: "Save" }));
  });

  it("tells live clients when a late registration widens the set", () => {
    const changed = jest.fn();
    attach(makeWrapper(""), { delegatedEventsChanged: changed });
    registerAttribute({ name: "w", selectors: ["*"], delegatedEvents: ["my-event"], setup: () => {} });
    expect(changed).toHaveBeenCalledTimes(1);
    registerAttribute({ name: "plain", selectors: ["[p]"], setup: () => {} });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("removes declared types on teardown, not only the built-ins", () => {
    registerAttribute({ name: "w", selectors: ["*"], delegatedEvents: ["my-widget-change"], setup: () => {} });
    const send = jest.fn();
    const wrapper = makeWrapper(widget);
    const delegator = delegatorFor(wrapper, send);
    delegator.setupEventDelegation();
    fire();
    expect(send).toHaveBeenCalledTimes(1);
    delegator.teardownForWrapper(wrapper.getAttribute("data-lvt-id"));
    fire();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("warns about an uppercase type, which lvt-on: can never name", () => {
    registerAttribute({ name: "w", selectors: ["*"], delegatedEvents: ["myEvent"], setup: () => {} });
    expect(warn.mock.calls.map((a) => a.join(" ")).join("\n")).toMatch(/lowercase/);
  });

  it("dedupes a declared type that is already built in", () => {
    registerAttribute({ name: "w", selectors: ["*"], delegatedEvents: ["click"], setup: () => {} });
    expect(delegatedEventTypes().filter((t) => t === "click")).toHaveLength(1);
  });
});
