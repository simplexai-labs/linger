import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { Message } from "@/i18n/messages";
import {
  voiceClosesByEnglishName,
  voiceRiskOfEnglishName,
} from "./voice-ui-bridge";

// A translated control is named in the language on screen, so Voice Mode
// cannot tell from its name that clicking it deletes, sends or closes
// something. The control says so with `data-voice-risk` or
// `data-voice-close`; this test finds every control named by a message whose
// English name Voice Mode would treat as risky or as a close button, and
// fails when the control lacks the marker.

const messageModules = import.meta.glob<
  Record<string, Record<string, Message>>
>("/src/**/*.messages.ts", { eager: true });
const sourceFiles = import.meta.glob<string>(
  ["/src/**/*.tsx", "!/src/**/*.test.tsx", "!/src/test/**"],
  { eager: true, import: "default", query: "?raw" },
);

/** Messages by their exported group name and their own name. */
const groups = new Map<string, Record<string, Message>>();
for (const exports of Object.values(messageModules))
  for (const [name, messages] of Object.entries(exports))
    groups.set(name, messages);

/**
 * Controls named by a risky-sounding message that are not that action, by
 * `file: namespace.name`, with the reason.
 */
const notActions: Record<string, string> = {
  "/src/features/auth/teamhub-login-page.tsx: auth.hidePassword":
    "shows or hides the password in place; it closes nothing",
  "/src/features/local-models/local-model-advanced-dialog.tsx: localModels.hideGatewayPassword":
    "shows or hides the gateway password in place; it closes nothing",
  "/src/features/rooms/chat/room-notice-row.tsx: chat.hideChanges":
    "folds the change list in place; it closes nothing",
  "/src/features/rooms/task-sidebar/collaboration-panel.tsx: collaboration.hideSource":
    "folds the source in place; it closes nothing",
  "/src/features/rooms/room-secondary-navigation.tsx: roomList.deletedChat":
    "says the Agent of a direct chat was deleted; the link only opens the chat",
  "/src/features/rooms/room-secondary-navigation.tsx: roomList.deleted":
    "says the Agent of a direct chat was deleted; the link only opens the chat",
  "/src/features/rooms/chat/voice-mode/voice-mode-controls.tsx: voiceMode.dictationHint":
    "describes the button that starts Voice Mode, which sends nothing itself",
  "/src/features/local-computer/remove-computer-agent-row.tsx: computers.deleteAgentInstead":
    "chooses what removing the computer does; the marked Remove button does it",
  "/src/features/apps/web-search-connectors.tsx: connectors.searchKeyRejected":
    "the status line of a backend card, which is not a control",
  "/src/features/rooms/cards/decision-search-key-view.tsx: cards.hideOtherProviders":
    "folds the other providers' key fields in place; it closes nothing",
  "/src/features/rooms/files/artifact-preview-surface.tsx: filePreview.exitFullScreen":
    "leaves full screen in place; it decides nothing and closes nothing",
  "/src/features/rooms/files/artifact-content-renderer.tsx: filePreview.resetImageZoom":
    "resets the image zoom in place; it decides nothing",
  "/src/features/rooms/documents/document-share-dialog.tsx: documentShare.removeAccess":
    "the permission option only opens the confirm dialog; its marked Remove access button removes",
  "/src/features/rooms/documents/room-document-comment-thread.tsx: documentComments.deletedReference":
    "says the quoted text of a comment was deleted; the button only scrolls to the quote",
};

type Need = "confirm" | "never" | "close";

interface Finding {
  file: string;
  message: string;
  english: string;
  need: Need;
  line: number;
}

function needs(english: string): Need | undefined {
  if (voiceClosesByEnglishName(english)) return "close";
  return voiceRiskOfEnglishName(english);
}

const controlTag =
  /^(?:button|a|summary)$|(?:Button|MenuItem|Item|Link|Trigger|Toggle|Action)$/u;
const nameAttributes = new Set(["aria-label", "title", "label", "text"]);

type JsxTag = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function attribute(tag: JsxTag, name: string) {
  return tag.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function isControl(tag: JsxTag) {
  return (
    controlTag.test(tag.tagName.getText()) ||
    attribute(tag, "onClick") !== undefined ||
    attribute(tag, "onSelect") !== undefined
  );
}

function hasMarker(tag: JsxTag, need: Need) {
  const marker = attribute(
    tag,
    need === "close" ? "data-voice-close" : "data-voice-risk",
  );
  if (!marker) return false;
  if (need === "close") return true;
  const value = marker.initializer;
  // A value worked out at render time is trusted; a literal must match.
  return !value || !ts.isStringLiteral(value) || value.text === need;
}

/** The JSX tag a name inside it names: an attribute's tag or a text's control. */
function namedTag(node: ts.Node): JsxTag | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isJsxAttribute(current)) {
      const tag = current.parent.parent;
      return nameAttributes.has(current.name.getText()) && isControl(tag)
        ? tag
        : undefined;
    }
    if (ts.isJsxElement(current) && isControl(current.openingElement))
      return current.openingElement;
    if (
      ts.isFunctionLike(current) ||
      ts.isVariableDeclaration(current) ||
      ts.isPropertyAssignment(current)
    )
      return undefined;
  }
  return undefined;
}

/** A menu item described as an object: `{ label: t(m.delete), voiceRisk: "never" }`. */
function namedItem(node: ts.Node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isPropertyAssignment(current))
      return current.name.getText() === "label" &&
        ts.isObjectLiteralExpression(current.parent)
        ? current.parent
        : undefined;
    if (ts.isFunctionLike(current) || ts.isJsxAttribute(current))
      return undefined;
  }
  return undefined;
}

function itemMarker(item: ts.ObjectLiteralExpression, need: Need) {
  const key = need === "close" ? "voiceClose" : "voiceRisk";
  const property = item.properties.find(
    (entry) => entry.name?.getText() === key,
  );
  if (!property) return false;
  if (need === "close" || !ts.isPropertyAssignment(property)) return true;
  const value = property.initializer;
  return !ts.isStringLiteral(value) || value.text === need;
}

/** `m` for `import { fooMessages as m }` or `const m = fooMessages`. */
function aliases(file: ts.SourceFile) {
  const names = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (
      ts.isImportSpecifier(node) &&
      groups.has(node.propertyName?.text ?? node.name.text)
    )
      names.set(node.name.text, node.propertyName?.text ?? node.name.text);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      groups.has(node.initializer.text)
    )
      names.set(node.name.text, node.initializer.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/** The messages an expression may show: `m.name`, or either side of `a ? m.x : m.y`. */
function messagesOf(
  node: ts.Expression,
  names: Map<string, string>,
): Message[] {
  if (ts.isParenthesizedExpression(node))
    return messagesOf(node.expression, names);
  if (ts.isConditionalExpression(node))
    return [
      ...messagesOf(node.whenTrue, names),
      ...messagesOf(node.whenFalse, names),
    ];
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const group = groups.get(names.get(node.expression.text) ?? "");
    const message = group?.[node.name.text];
    return message ? [message] : [];
  }
  return [];
}

function forms(message: Message): string[] {
  const source = message.source as unknown;
  return typeof source === "string"
    ? [source]
    : Object.values(source as Record<string, string>);
}

/** Every place a variable holding a message's text is shown. */
function uses(file: ts.SourceFile, name: string) {
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    const parent = node.parent;
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      !(
        (ts.isVariableDeclaration(parent) ||
          ts.isJsxAttribute(parent) ||
          ts.isPropertyAccessExpression(parent) ||
          ts.isPropertyAssignment(parent)) &&
        parent.name === node
      )
    )
      found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function missingMarkers(path: string, text: string): Finding[] {
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = aliases(file);
  if (names.size === 0) return [];
  const findings: Finding[] = [];
  const check = (place: ts.Node, message: Message, need: Need) => {
    const key = `${path}: ${message.id}`;
    if (key in notActions) return;
    const tag = namedTag(place);
    const item = tag ? undefined : namedItem(place);
    if ((tag && hasMarker(tag, need)) || (item && itemMarker(item, need)))
      return;
    if (!tag && !item) return;
    findings.push({
      file: path,
      message: message.id,
      english: forms(message).join(" / "),
      need,
      line: file.getLineAndCharacterOfPosition(place.getStart()).line + 1,
    });
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments[0]) {
      for (const message of messagesOf(node.arguments[0], names)) {
        const need = forms(message).map(needs).find(Boolean);
        if (!need) continue;
        check(node, message, need);
        // `const label = t(m.delete)` shown later as `{label}`.
        const holder = node.parent;
        if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name))
          for (const use of uses(file, holder.name.text))
            check(use, message, need);
        if (
          ts.isBinaryExpression(holder) &&
          ts.isVariableDeclaration(holder.parent) &&
          ts.isIdentifier(holder.parent.name)
        )
          for (const use of uses(file, holder.parent.name.text))
            check(use, message, need);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

describe("Voice Mode markers on translated controls", () => {
  it("reads the client's message modules and components", () => {
    expect(groups.has("commonMessages")).toBe(true);
    expect(Object.keys(sourceFiles).length).toBeGreaterThan(100);
  });

  it("marks every translated control Voice Mode must not click unasked or closes by", () => {
    const findings = Object.entries(sourceFiles).flatMap(([path, text]) =>
      missingMarkers(path, text),
    );
    expect(
      findings.map(
        ({ file, line, message, english, need }) =>
          `${file}:${line} ${message} "${english}" needs ${
            need === "close" ? "data-voice-close" : `data-voice-risk="${need}"`
          }`,
      ),
    ).toEqual([]);
  });

  it("knows each exception by a control that still exists", () => {
    for (const key of Object.keys(notActions)) {
      const [path, id] = key.split(": ") as [string, string];
      const name = id.split(".")[1]!;
      expect(sourceFiles[path], key).toContain(`.${name}`);
    }
  });
});
