import {
  textOffsetsFromSelection,
  handleTextSelectDirectives,
  teardownTextSelectForRoot,
} from "../dom/directives";

// Build a `.code` host whose lines mirror prereview's structure: each line is a
// [data-line] row with a gutter span (excluded from offsets) and a
// [data-line-text] content span holding one or more token spans (as chroma
// emits). Returns the host and its content spans for boundary setting.
function mountCode(
  lines: Array<{ line: number; side?: string; tokens: string[] }>
): { host: HTMLElement; contents: HTMLElement[] } {
  const host = document.createElement("div");
  host.setAttribute("lvt-fx:text-select", "selectText");
  const contents: HTMLElement[] = [];
  for (const l of lines) {
    const row = document.createElement("div");
    row.setAttribute("data-line", String(l.line));
    if (l.side) row.setAttribute("data-side", l.side);
    const gutter = document.createElement("span");
    gutter.textContent = String(l.line); // line number — must NOT count
    row.appendChild(gutter);
    const content = document.createElement("span");
    content.setAttribute("data-line-text", "");
    for (const tok of l.tokens) {
      const span = document.createElement("span");
      span.textContent = tok;
      content.appendChild(span);
    }
    row.appendChild(content);
    host.appendChild(row);
    contents.push(content);
  }
  document.body.appendChild(host);
  return { host, contents };
}

// selectRange builds a native selection from (startNode, startOffset) to
// (endNode, endOffset) and returns window.getSelection().
function selectRange(
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number
): Selection {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

// firstText returns the text node inside the i-th token span of a content el.
function tokenText(content: HTMLElement, tokenIndex: number): Text {
  return content.children[tokenIndex].firstChild as Text;
}

afterEach(() => {
  teardownTextSelectForRoot(document.body); // drop any armed window keydown listeners
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

describe("textOffsetsFromSelection", () => {
  it("resolves a single-word selection to rune columns, excluding the gutter", () => {
    // "the quick brown fox" split as tokens; select "brown".
    const { host, contents } = mountCode([
      { line: 42, tokens: ["the ", "quick ", "brown ", "fox"] },
    ]);
    const brown = tokenText(contents[0], 2); // "brown "
    const sel = selectRange(brown, 0, brown, 5); // "brown"
    const r = textOffsetsFromSelection(sel, host);
    expect(r).not.toBeNull();
    expect(r).toMatchObject({
      fromLine: 42,
      toLine: 42,
      fromCol: 10, // "the quick " = 10 chars
      toCol: 15, // + "brown"
      text: "brown",
    });
    expect(r!.side).toBeUndefined(); // new side
  });

  it("spans multiple token spans within one line", () => {
    const { host, contents } = mountCode([
      { line: 7, tokens: ["the ", "quick ", "brown ", "fox"] },
    ]);
    // from inside "quick " (offset 2 → after "qu") to inside "fox" (offset 2 → "fo")
    const sel = selectRange(tokenText(contents[0], 1), 2, tokenText(contents[0], 3), 2);
    const r = textOffsetsFromSelection(sel, host);
    expect(r).toMatchObject({
      fromLine: 7,
      toLine: 7,
      fromCol: 6, // "the qu" = 6
      toCol: 18, // "the quick brown fo" = 18
      text: "ick brown fo",
    });
  });

  it("resolves a multi-line selection (fromLine != toLine)", () => {
    const { host, contents } = mountCode([
      { line: 10, tokens: ["alpha beta"] },
      { line: 11, tokens: ["gamma delta"] },
    ]);
    // from "beta" start on line 10 to after "gamma" on line 11
    const sel = selectRange(tokenText(contents[0], 0), 6, tokenText(contents[1], 0), 5);
    const r = textOffsetsFromSelection(sel, host);
    expect(r).toMatchObject({
      fromLine: 10,
      fromCol: 6, // "alpha " = 6
      toLine: 11,
      toCol: 5, // "gamma" = 5
    });
  });

  it("counts a surrogate-pair char (emoji) as one rune column", () => {
    // "☕ x brownY" — the ☕ before the target counts as ONE column.
    const { host, contents } = mountCode([{ line: 3, tokens: ["☕ ab", "cd"] }]);
    // select "cd" (offset 0..2 in second token). Preceding text "☕ ab" = 4 runes.
    const sel = selectRange(tokenText(contents[0], 1), 0, tokenText(contents[0], 1), 2);
    const r = textOffsetsFromSelection(sel, host);
    expect(r).toMatchObject({ fromCol: 4, toCol: 6, text: "cd" });
  });

  it("reads data-side='old' onto the range", () => {
    const { host, contents } = mountCode([
      { line: 5, side: "old", tokens: ["removed line"] },
    ]);
    const sel = selectRange(tokenText(contents[0], 0), 0, tokenText(contents[0], 0), 7);
    const r = textOffsetsFromSelection(sel, host);
    expect(r).toMatchObject({ fromLine: 5, side: "old", text: "removed" });
  });

  it("returns null for a collapsed selection", () => {
    const { host, contents } = mountCode([{ line: 1, tokens: ["abc"] }]);
    const sel = selectRange(tokenText(contents[0], 0), 1, tokenText(contents[0], 0), 1);
    expect(textOffsetsFromSelection(sel, host)).toBeNull();
  });

  it("returns null when a boundary is in the gutter (not the text container)", () => {
    const { host } = mountCode([{ line: 1, tokens: ["abc"] }]);
    const gutter = host.querySelector("[data-line] > span:first-child")!.firstChild as Text;
    const content = host.querySelector("[data-line-text]")!.firstChild!.firstChild as Text;
    const sel = selectRange(gutter, 0, content, 2);
    expect(textOffsetsFromSelection(sel, host)).toBeNull();
  });

  it("returns null when the selection crosses the diff old/new boundary", () => {
    const { host, contents } = mountCode([
      { line: 5, side: "old", tokens: ["deleted"] },
      { line: 6, tokens: ["added"] }, // new side
    ]);
    const sel = selectRange(tokenText(contents[0], 0), 0, tokenText(contents[1], 0), 3);
    expect(textOffsetsFromSelection(sel, host)).toBeNull();
  });

  it("returns null when the selection lands outside the host", () => {
    const { host } = mountCode([{ line: 1, tokens: ["abc"] }]);
    const outside = document.createElement("p");
    outside.textContent = "elsewhere";
    document.body.appendChild(outside);
    const t = outside.firstChild as Text;
    const sel = selectRange(t, 0, t, 4);
    expect(textOffsetsFromSelection(sel, host)).toBeNull();
  });
});

describe("keyboard commit gating (regression: bot review of #140)", () => {
  // Arming renders the block caret, which reads Range layout geometry. jsdom
  // does no layout (getClientRects is absent), so stub the two Range layout
  // methods — real geometry is covered by the chromedp e2e, not here.
  const emptyRects = Object.assign([], { item: () => null }) as unknown as DOMRectList;
  const zeroRect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
  beforeAll(() => {
    (Range.prototype as any).getClientRects = () => emptyRects;
    (Range.prototype as any).getBoundingClientRect = () => zeroRect;
  });

  it("does NOT commit on Enter while a text field is focused, even with a live host selection", () => {
    const { host, contents } = mountCode([{ line: 1, tokens: ["alpha beta"] }]);
    host.setAttribute("lvt-fx:text-select", "selectText");
    const send = jest.fn();
    handleTextSelectDirectives(document.body, send);

    // A live, non-collapsed selection inside the host...
    selectRange(tokenText(contents[0], 0), 0, tokenText(contents[0], 0), 5);
    // ...but focus is in an unrelated textarea (e.g. the composer). Tab does not
    // collapse the document selection, so haveSel is still true.
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();
    expect(document.activeElement).toBe(ta);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    expect(send).not.toHaveBeenCalled(); // Enter belongs to the textarea, not us
  });

  it("DOES commit on Enter when focus is not in a text field", () => {
    const { host, contents } = mountCode([{ line: 1, tokens: ["alpha beta"] }]);
    host.setAttribute("lvt-fx:text-select", "selectText");
    const send = jest.fn();
    handleTextSelectDirectives(document.body, send);
    selectRange(tokenText(contents[0], 0), 0, tokenText(contents[0], 0), 5); // "alpha"
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ action: "selectText" });
  });
});

describe("keyboard scoping (regression: bot review round 2 of #140)", () => {
  const emptyRects = Object.assign([], { item: () => null }) as unknown as DOMRectList;
  const zeroRect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
  beforeAll(() => {
    (Range.prototype as any).getClientRects = () => emptyRects;
    (Range.prototype as any).getBoundingClientRect = () => zeroRect;
  });

  it("ignores Enter when an unrelated non-editable widget is focused", () => {
    const { host, contents } = mountCode([{ line: 1, tokens: ["alpha beta"] }]);
    host.setAttribute("lvt-fx:text-select", "selectText");
    const send = jest.fn();
    handleTextSelectDirectives(document.body, send);
    selectRange(tokenText(contents[0], 0), 0, tokenText(contents[0], 0), 5); // live selection

    // Focus an unrelated widget OUTSIDE the host (e.g. a custom dropdown button).
    const widget = document.createElement("button");
    document.body.appendChild(widget);
    widget.focus();
    expect(document.activeElement).toBe(widget);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
    );
    expect(send).not.toHaveBeenCalled(); // the widget owns the key, not us
  });

  it("does not preventDefault ArrowRight when an unrelated widget is focused", () => {
    const { host } = mountCode([{ line: 1, tokens: ["alpha"] }]);
    host.setAttribute("lvt-fx:text-select", "selectText");
    handleTextSelectDirectives(document.body, jest.fn());
    const widget = document.createElement("button");
    document.body.appendChild(widget);
    widget.focus();

    const ev = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false); // left for the focused widget
  });
});
