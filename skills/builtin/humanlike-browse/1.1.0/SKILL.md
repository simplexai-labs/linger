---
name: humanlike-browse
description: Read, survey, post to or manage a site where the user is signed in, or write for the user on a social network or a marketplace, through ui.computer in ui_exec, in the Computer's own window of the user's browser. Use whenever a task needs the user's sign-in on such a site or acts there for the user, or when ui.page meets a captcha, a block page or a sign-in wall. Pages any visitor can read without signing in use ui.page instead.
---

# Sites that watch for automated browsing

## How to call the computer methods

Every method below runs inside one `ui_exec` script as `await ui.computer.<method>({...})`. There are no separate tools with these names. Keep ids across calls in `state`, such as `state.pid`.

Open a site and read its window in one script:

```js
const r = await ui.computer.launch_app({agent_browser: true, urls: ["https://www.reddit.com/"]});
state.pid = r.structuredContent.pid;
state.window_id = r.structuredContent.windows[0].window_id;
const v = await ui.window(state.pid, state.window_id).observe();
return v.text;
```

In a later script, read again with `let v = await ui.window(state.pid, state.window_id).observe()`, and click with `v = await v.click("AXButton", "Search")`, copying the role and the quoted name from `v.text`.

## Choose the route

- A public fact or a list of pages: `teamhub web search`. One public page that needs no clicks: `teamhub web open`. Never open a search engine's results page.
- Pages any visitor can read without signing in, such as listings or public threads: `ui.page(url)`, which is faster, but only while its browser is the dedicated Agent Chrome profile (the `navigate` method in `await ui.help('browser')` names the browser mode). When `ui.page` drives the user's own Chrome, use `ui.computer` on social networks and marketplaces instead. If the site answers `ui.page` with a captcha, a block page or a sign-in wall, switch that site to `ui.computer` as below.
- A page that needs the user's sign-in, or any write for the user, such as a post, a message, a purchase or a setting, on a social network, a marketplace or a site where the user is signed in: only `ui.computer`, starting with `ui.computer.launch_app({agent_browser: true, urls: [homeURL]})`. In Chrome or Safari this opens a window of the Computer's own in the user's everyday browser, with the user's sign-ins. Pass `bundle_id` only when the user asks for one browser. Never use `ui.page` for the user's signed-in account.
- If `await ui.help('computer')` lists no `agent_browser` for `launch_app`, this needs a Mac Computer: tell the user and stop.
- Never ask the user to quit or restart their browser. If `launch_app` says the Chrome window updates only while part of it shows on the user's screen and a page stops changing, ask the user to leave part of that window uncovered.
- If the site asks to sign in, ask the user to sign in once in that browser window and stop; the sign-in stays for later tasks.

## Move like a person

These sites watch how a visitor moves, and the user may watch the window. Every page change looks like a person's.

- Open each site once with `launch_app`, at its home page. A page the user names, such as a forum, a search or their order list, is reached from the home page through the site's own controls. Never call `launch_app` again for another page of a site already open.
- Reach each page the way a person does: the site's search box, menus, filters, sort controls and page links.
- Never type an address into the address bar, and never build a search, filter or page address yourself.
- If the page cannot be reached from the home page, such as a private share link, tell the user and stop.
- Go back through the page's own links, such as the site's logo. Close a tab the item opened with its Close button.
- To see more of a list that grows as it scrolls, call `ui.computer.scroll({pid, window_id, direction: "down", amount: 5})`. Use the site's next-page link for a paged list.

## Fill a search box

The user's Chrome takes no keys from the Computer, so fill fields with `setValue` inside `ui.computer.run_script`. Its script uses its own `cua` API and receives values through `args`:

```js
const out = await ui.computer.run_script({
  args: {pid: state.pid, window_id: state.window_id, query: "camping kettle"},
  script: `
    const app = await cua.getApp({pid: args.pid, windowId: args.window_id});
    await app.setValue({role: "AXTextField", name: "Search"}, args.query);
    await app.click({role: "AXButton", name: "Search"});
    await app.waitFor({role: "AXLink", name: "Next", timeout_ms: 8000});
    return (await app.getState({query: "kettle"})).tree_markdown;
  `,
});
return out.content.map((part) => part.text).join("\n");
```

- `cua` exists only inside the `run_script` string, never in the `ui_exec` script itself.
- Always pass `pid` and `window_id` in `args`, with these names: the Computer checks that window before the script runs.
- Inside it: `app.setValue(t, value)`, `app.click(t)`, `app.query({role, name})`, `app.waitFor({role, name, text, timeout_ms})` and `app.getState({query})`, where `t` is `{role, name}` with the exact label.
- In Chrome never use `typeText`, `hotkey` or `pressKey`. Wait with `app.waitFor` for what the next page shows, never with `cua.sleep`.

## Keep it quick

The user watches the window, and each turn costs seconds. The Computer already spaces each input like a quick person; add no waits of your own.

- Browse in this conversation yourself. Do not hand the browsing to a background Task.
- Do a whole page visit in one `ui_exec`: search, read, open the item, read it, go back. Return to the model only to choose, such as which items to open.
- Read only what you need: pass `query` to `ui.computer.get_window_state({pid, window_id, query})` to narrow a long page.

## Read

- `ui.window(pid, window_id).observe()` returns the whole page the browser has loaded, including the part below the window. If a read says it was cut, read again narrower.
- Text inside pictures, or a state the text does not show, such as liked: `ui.emit(await ui.computer.get_window_state({pid, window_id, include_screenshot: true}))`.
- Stop scrolling when two reads add no new items. One search per keyword; never reopen an item already read.
- Act only in tabs this task opened. Close each item's tab after reading it. If a tab the task did not open is in front, stop and tell the user.

## Write

Write only when the user asked for that action in this task: publish, comment, like, follow or delete. Text to review or a request to draft is not permission.

1. Check on the page that the signed-in account is the one the user meant. If not, stop and tell the user.
2. Make sure exactly one item matches the target. If several do, ask.
3. Send once, then read the page again and confirm the result shows.
4. If the result is unclear, read the page. Never send again blind.

If the user takes over the window, read the page and the account again before the next input.

## Checks and limits

- When a page shows a captcha, a code or QR check, a sign-in wall or a too-many-requests message, call `ui.computer.report_blocker({kind, url})` at once, with kind `captcha`, `verification`, `login_required` or `rate_limited`. Then tell the user in the Room what the page asks for and that they can deal with it in that browser window, report what was done, and end the task.
- When only one item cannot be viewed, call `ui.computer.report_blocker({kind: "content_unavailable", url})` and skip it.
- Never pass a check yourself, switch accounts or retry around a limit.
- When the Computer refuses input with `COMPUTER_INPUT_BUDGET`, `COMPUTER_SITE_COOLDOWN` or `COMPUTER_SITE_BLOCKED`, report what was done and end the task.
- When it refuses input with `COMPUTER_TAB_CHANGED`, read the window. Go on only if the tab in front is the page this task was working on; otherwise report what was done and end the task.
