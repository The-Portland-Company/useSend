import { mergeAttributes, Node } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    section: {
      setSection: (attrs?: Record<string, unknown>) => ReturnType;
    };
  }
}

/**
 * A container / card block: wraps other blocks with a background color,
 * padding, rounded corners and an optional border. Enables dark callout
 * cards and light bordered feature cards that plain blocks can't express.
 */
export const SectionExtension = Node.create({
  name: "section",
  group: "block",
  content: "block+",
  draggable: true,
  defining: true,

  addAttributes() {
    const attr = (def: unknown) => ({ default: def, rendered: false });
    return {
      backgroundColor: attr("transparent"),
      textColor: attr(null),
      padding: attr("24"),
      borderRadius: attr("10"),
      borderWidth: attr("0"),
      borderColor: attr("transparent"),
    };
  },

  parseHTML() {
    return [{ tag: `div[data-unsend-component="${this.name}"]` }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const {
      backgroundColor,
      textColor,
      padding,
      borderRadius,
      borderWidth,
      borderColor,
    } = node.attrs;
    const style = [
      `background-color:${backgroundColor}`,
      `color:${textColor || "inherit"}`,
      `padding:${padding}px`,
      `border-radius:${borderRadius}px`,
      `border:${borderWidth}px solid ${borderColor}`,
      "margin-bottom:16px",
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

  addCommands() {
    return {
      setSection:
        (attrs = {}) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              backgroundColor: "#1d2b0c",
              textColor: "#ffffff",
              ...attrs,
            },
            content: [{ type: "paragraph" }],
          }),
    };
  },
});
