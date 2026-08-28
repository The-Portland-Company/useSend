import { mergeAttributes, Node } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    columns: {
      setColumns: (count?: number) => ReturnType;
    };
  }
}

/**
 * A single column inside a `columns` row. Holds arbitrary block content and
 * carries a width (e.g. "130px", "50%", or "auto").
 */
export const ColumnExtension = Node.create({
  name: "column",
  content: "block+",
  isolating: true,

  addAttributes() {
    return {
      width: { default: "auto", rendered: false },
      verticalAlign: { default: "top", rendered: false },
    };
  },

  parseHTML() {
    return [{ tag: `div[data-unsend-component="${this.name}"]` }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { width, verticalAlign } = node.attrs;
    const style = [
      width === "auto" ? "flex:1 1 0" : `flex:0 0 ${width};width:${width}`,
      "min-width:0",
      `vertical-align:${verticalAlign}`,
    ].join(";");
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-unsend-component": this.name,
        style,
      }),
      0,
    ];
  },
});

/**
 * A horizontal row of columns — renders side-by-side on desktop mail clients.
 * Powers side-by-side headers, icon+text feature rows and split footers.
 */
export const ColumnsExtension = Node.create({
  name: "columns",
  group: "block",
  content: "column+",
  draggable: true,
  defining: true,

  parseHTML() {
    return [{ tag: `div[data-unsend-component="${this.name}"]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-unsend-component": this.name,
        style: "display:flex;gap:16px;margin-bottom:16px;align-items:flex-start;",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setColumns:
        (count = 2) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            content: Array.from({ length: count }, () => ({
              type: "column",
              content: [{ type: "paragraph" }],
            })),
          }),
    };
  },
});
